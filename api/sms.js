// api/sms.js
// Vercel serverless Twilio SMS webhook with Upstash Redis
// - Whitelisted numbers: always reply with password (no cooldown/caps)
// - Unknown numbers: cooldown + per-number/day + global/day caps
// - Optional keyword gate via REQUIRE_KEYWORD env (applies to everyone)
// - STOP/HELP compliance
//
// Env vars to set in Vercel (and .env for local):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   SITE_PASSWORD=YourWeddingPassword
//   REQUIRE_KEYWORD=PASSWORD           (optional; leave empty to disable)
//   MIN_REPLY_COOLDOWN_MIN=3           (optional; unknowns only)
//   MAX_PER_NUMBER_PER_DAY=3           (optional; unknowns only)
//   GLOBAL_MAX_PER_DAY=2000            (optional; all replies counted)
//
// Twilio number -> Messaging Webhook (POST):
//   https://<your-app>.vercel.app/api/sms
//
// Add guests in Upstash Console (Redis):
//   SADD whitelist +15551234567 +15557654321
// Remove guests in Upstash Console (Redis):
//   SREM whitelist +15557654321

// api/sms.js — with verbose logging for Vercel
import {twiml as TwiML} from 'twilio';
import {redis} from '../lib/redis.js';
import {
    SITE_PASSWORD,
    MIN_REPLY_COOLDOWN_MIN,
    MAX_PER_NUMBER_PER_DAY,
    GLOBAL_MAX_PER_DAY,
    REQUIRED_TEXT_KEYWORD,
    ALLOW_PASSWORD_REJOIN,
    OPT_OUTS,
    OPT_INS,
    HELP_WORDS,
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
            return res.status(405).send('Method Not Allowed');
        }

        const params = await parseFormBody(req);
        const from = (params.From || '').trim();
        const body = (params.Body || '').trim();
        const upper = body.toUpperCase();
        const today = dayKey();
        const twiml = new TwiML.MessagingResponse();

        console.log(`[${reqId}] Incoming SMS`, {
            From: from,
            Body: body,
            Today: today,
        });

        // STOP → record and stay silent
        if (OPT_OUTS.some((k) => upper.includes(k))) {
            console.log(`[${reqId}] STOP/opt-out detected from ${from}`);
            await recordOptOut(from);
            return res.status(204).end();
        }

        // HELP → reply with help text
        if (HELP_WORDS.some((k) => upper.includes(k))) {
            console.log(`[${reqId}] HELP detected from ${from}`);
            twiml.message(
                'Robyn & Kingsley Wedding Website Password Responder. Reply STOP to opt out.'
            );
            res.setHeader('Content-Type', 'text/xml');
            console.log(`[${reqId}] Responding with HELP message`);
            return res.status(200).send(twiml.toString());
        }

        // START → clear opt-out and continue (still require keyword below)
        if (OPT_INS.some((k) => upper.includes(k))) {
            console.log(`[${reqId}] START/opt-in detected from ${from}`);
            await clearOptOut(from);
        }

        // Still opted out?
        const optedOut = await isOptedOut(from);
        if (
            optedOut &&
            !(
                ALLOW_PASSWORD_REJOIN &&
                REQUIRED_TEXT_KEYWORD &&
                upper.includes(REQUIRED_TEXT_KEYWORD)
            )
        ) {
            console.log(`[${reqId}] Number is opted-out, ignoring ${from}`);
            return res.status(204).end();
        }

        // They sent PASSWORD while opted-out
        if (optedOut) {
            console.log(`[${reqId}] PASSWORD rejoin allowed for ${from}`);
            await clearOptOut(from);
        }

        // Keyword required to proceed
        if (REQUIRED_TEXT_KEYWORD && !upper.includes(REQUIRED_TEXT_KEYWORD)) {
            console.log(
                `[${reqId}] Keyword gate failed. Required="${REQUIRED_TEXT_KEYWORD}", got="${body}"`
            );
            return res.status(204).end();
        }

        // Check Whitelist first
        const isWhitelisted = await redis.sismember('whitelist', from);
        if (isWhitelisted) {
            console.log(`[${reqId}] Whitelisted number: ${from}`);
            twiml.message(`Hi! Here’s the password: ${SITE_PASSWORD}`);
            res.setHeader('Content-Type', 'text/xml');
            console.log(
                `[${reqId}] Responding with password (WHITELIST) in ${
                    Date.now() - started
                }ms`
            );
            return res.status(200).send(twiml.toString());
        }

        // Unknown numbers: run abuse guards
        const guard = await runUnknownAbuseGuards({from, body, today});
        if (!guard.allow) {
            console.log(`[${reqId}] Blocked by abuse guard for ${from}`);
            return res.status(204).end();
        }

        // Unknowns Numbers: throttles
        const {globalKey, countKey, lastKey, globalCount, numberCount, lastMs} =
            await getUnknownThrottleState({from, today});

        console.log(`[${reqId}] Throttle state`, {
            globalCount,
            numberCount,
            lastMs,
        });

        if (globalCount >= GLOBAL_MAX_PER_DAY) {
            console.log(
                `[${reqId}] Global cap reached (${GLOBAL_MAX_PER_DAY})`
            );
            return res.status(204).end();
        }

        const now = Date.now();
        const minMs = MIN_REPLY_COOLDOWN_MIN * 60 * 1000;
        if (lastMs && now - lastMs < minMs) {
            console.log(`[${reqId}] Cooldown active for ${from}`);
            return res.status(204).end();
        }
        if (numberCount >= MAX_PER_NUMBER_PER_DAY) {
            console.log(`[${reqId}] Per-number cap reached for ${from}`);
            return res.status(204).end();
        }

        // Fallback for unknown numbers
        twiml.message(
            'We couldn’t match this number to our guest list. If this is a mistake, please contact Kingsley.'
        );

        await recordUnknownReply({globalKey, countKey, lastKey, now});

        res.setHeader('Content-Type', 'text/xml');
        console.log(
            `[${reqId}] Responding with fallback for unknown in ${
                Date.now() - started
            }ms`
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
