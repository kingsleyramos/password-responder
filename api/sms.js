// api/sms.js — Twilio webhook (uses centralized config + lean helpers)
import {twiml as TwiML} from 'twilio';
import {redis} from '../lib/redis.js';
import {
    SITE_PASSWORD,
    HELP_MESSAGE,
    REQUIRED_TEXT_KEYWORD,
    ALLOW_PASSWORD_REJOIN,
    MIN_REPLY_COOLDOWN_MIN,
    MAX_PER_NUMBER_PER_DAY,
    GLOBAL_MAX_PER_DAY,
    OPT_OUTS,
    OPT_INS,
    HELP_WORDS,
    KEYS,
    TTL,
} from '../lib/config.js';
import {dayKey, parseFormBody} from '../lib/utils.js';
import {recordOptOut, clearOptOut, isOptedOut} from '../lib/optout.js';
import {runUnknownAbuseGuards} from '../lib/abuse.js';
import {getUnknownThrottleState, recordUnknownReply} from '../lib/throttle.js';

export default async function handler(req, res) {
    const reqId = Math.random().toString(36).slice(2, 8);
    const started = Date.now();

    try {
        if (req.method !== 'POST') {
            console.warn(
                `[${reqId}] Non-POST request: ${req.method} ${req.url}`
            );
            return res.status(405);
        }

        const params = await parseFormBody(req);
        const fromNumber = (params.From || '').trim();
        const bodyRaw = (params.Body || '').trim();
        const bodyUpper = bodyRaw.toUpperCase();
        const today = dayKey();
        const messageSid = params.MessageSid || '(no-sid)';
        const keywordRequired = (REQUIRED_TEXT_KEYWORD || '').toUpperCase();

        console.log(`[${reqId}] Incoming`, {
            fromNumber,
            messageSid,
            today,
            bodyPreview: bodyRaw.slice(0, 80),
            env: process.env.VERCEL_ENV,
        });

        const twiml = new TwiML.MessagingResponse();

        // STOP → record and stay silent
        if (OPT_OUTS.some((k) => bodyUpper.includes(k))) {
            console.log(
                `[${reqId}] STOP detected → recording opt-out for ${fromNumber}`
            );
            await recordOptOut(fromNumber);
            return res.status(204).end();
        }

        // HELP → reply with help text
        if (HELP_WORDS.some((k) => bodyUpper.includes(k))) {
            console.log(
                `[${reqId}] HELP detected from ${fromNumber} → replying help`
            );
            twiml.message(HELP_MESSAGE);
            res.setHeader('Content-Type', 'text/xml');
            return res.status(200).send(twiml.toString());
        }

        // START → clear opt-out
        if (OPT_INS.some((k) => bodyUpper.includes(k))) {
            console.log(
                `[${reqId}] START detected → clearing opt-out for ${fromNumber}`
            );
            await clearOptOut(fromNumber);
        }

        // If still opted out, allow PASSWORD to rejoin (if configured)
        const stillOptedOut = await isOptedOut(fromNumber);
        if (
            stillOptedOut &&
            !(
                ALLOW_PASSWORD_REJOIN &&
                keywordRequired &&
                bodyUpper.includes(keywordRequired)
            )
        ) {
            console.log(`[${reqId}] ${fromNumber} is opted-out; ignoring`);
            return res.status(204).end();
        }
        if (stillOptedOut) {
            console.log(
                `[${reqId}] PASSWORD rejoin allowed → clearing opt-out for ${fromNumber}`
            );
            await clearOptOut(fromNumber);
        }

        // Keyword gate (applies to everyone)
        if (keywordRequired && !bodyUpper.includes(keywordRequired)) {
            console.log(
                `[${reqId}] Keyword gate failed; required="${keywordRequired}", got="${bodyRaw}"`
            );
            return res.status(204).end(); // silent
        }

        // Whitelist: always reply
        const isWhitelisted = await redis.sismember(KEYS.WHITELIST, fromNumber);
        if (isWhitelisted) {
            console.log(
                `[${reqId}] Whitelisted ${fromNumber} → sending password`
            );
            twiml.message(
                `Hi! Here’s the password to robyn-kingsley.wedding: ${SITE_PASSWORD}`
            );
            res.setHeader('Content-Type', 'text/xml');
            console.log(
                `[${reqId}] 200 Allowed ${fromNumber} in WHITELIST in ${
                    Date.now() - started
                }ms`
            );
            return res.status(200).send(twiml.toString());
        }

        // Unknowns: abuse guards (blocklist, burst, flood, content)
        const guard = await runUnknownAbuseGuards({
            from: fromNumber,
            body: bodyRaw,
            log: console,
        });
        if (!guard.allow) {
            console.log(
                `[${reqId}] Unknown ${fromNumber} blocked by abuse guards`
            );
            return res.status(204).end();
        }

        // Optional global/day cap (light single key)
        const globalDayKey = `${KEYS.GLOBAL_DAILY_PREFIX}${today}`;
        const globalCountRaw = await redis.get(globalDayKey);
        const globalCount = Number(globalCountRaw ?? 0);
        if (GLOBAL_MAX_PER_DAY && globalCount >= GLOBAL_MAX_PER_DAY) {
            console.log(
                `[${reqId}] Global/day cap reached (${GLOBAL_MAX_PER_DAY}); suppressing`
            );
            return res.status(204).end();
        }

        // Per-number throttles (hash-based)
        const {
            key: perNumberKey,
            numberCount,
            lastMs,
        } = await getUnknownThrottleState({
            from: fromNumber,
        });

        const now = Date.now();
        const minMs = MIN_REPLY_COOLDOWN_MIN * 60 * 1000;

        if (lastMs && now - lastMs < minMs) {
            const secs = Math.ceil((minMs - (now - lastMs)) / 1000);
            console.log(
                `[${reqId}] Cooldown for ${fromNumber} (~${secs}s left)`
            );
            return res.status(204).end();
        }

        if (MAX_PER_NUMBER_PER_DAY && numberCount >= MAX_PER_NUMBER_PER_DAY) {
            console.log(
                `[${reqId}] Per-number/day cap reached for ${fromNumber} (${numberCount}/${MAX_PER_NUMBER_PER_DAY})`
            );
            return res.status(204).end();
        }

        // Fallback for unknowns
        twiml.message(
            'We couldn’t match this number to our guest list. If this is a mistake, please contact Kingsley.'
        );

        await Promise.all([
            recordUnknownReply({key: perNumberKey, now}),
            // tiny global/day counter with TTL
            redis
                .incr(globalDayKey)
                .then(() => redis.expire(globalDayKey, TTL.GLOBAL_DAILY)),
        ]);

        res.setHeader('Content-Type', 'text/xml');
        console.log(
            `[${reqId}] 200 Unknown phone number in ${Date.now() - started}ms`
        );
        return res.status(200).send(twiml.toString());
    } catch (err) {
        console.error(`[${reqId}] ERROR`, {
            message: err?.message,
            stack: err?.stack,
        });
        return res.status(500).send(err?.message || 'Server Error');
    }
}
