/* eslint-disable no-process-env */
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
import {Redis} from '@upstash/redis';

const redis = Redis.fromEnv();

// --- Config (env) ---
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'PASSWORD';
const MIN_REPLY_COOLDOWN_MIN = parseInt(
    process.env.MIN_REPLY_COOLDOWN_MIN ?? '3',
    10
);
const MAX_PER_NUMBER_PER_DAY = parseInt(
    process.env.MAX_PER_NUMBER_PER_DAY ?? '3',
    10
);
const GLOBAL_MAX_PER_DAY = parseInt(
    process.env.GLOBAL_MAX_PER_DAY ?? '2000',
    10
);

const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || '').toUpperCase(); // e.g., "PASSWORD"

// If you know Advanced Opt-Out is ON and you *still* want to try PASSWORD as rejoin,
// leave this true. Delivery may still be blocked until START at carrier level.
const ALLOW_PASSWORD_REJOIN = true;

// --- Constants ---
const OPT_OUTS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const OPT_INS = ['START', 'UNSTOP', 'YES']; // Twilio-standard re-opt in
const HELP_WORDS = ['HELP', 'INFO'];

function dayKey(date = new Date()) {
    // Use local-day boundary by removing TZ offset from ISO date
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 10); // YYYY-MM-DD
}

export default async function handler(req, res) {
    const reqId = Math.random().toString(36).slice(2, 8);
    const started = Date.now();

    try {
        if (req.method !== 'POST') {
            console.warn(`[${reqId}] Non-POST request`, {
                method: req.method,
                url: req.url,
            });
            return res.status(405).send('Method Not Allowed');
        }

        // Parse application/x-www-form-urlencoded (Twilio default)
        const rawBody = await new Promise((resolve) => {
            let data = '';
            req.on('data', (chunk) => (data += chunk));
            req.on('end', () => resolve(data));
        });

        console.log(`[${reqId}] Incoming`, {
            url: req.url,
            ct: req.headers['content-type'],
            xTwilioSig: req.headers['x-twilio-signature']
                ? '<present>'
                : '<absent>',
            rawLen: rawBody.length,
        });

        const params = Object.fromEntries(new URLSearchParams(rawBody));
        const from = (params.From || '').trim();
        const body = (params.Body || '').trim();
        const upper = body.toUpperCase();
        const today = dayKey();
        const sid = params.MessageSid || '';

        console.log(`[${reqId}] Parsed`, {
            From: from,
            Body: body,
            Sid: sid,
            Day: today,
        });

        const twiml = new TwiML.MessagingResponse();

        // --- STOP / HELP handling & state tracking ---
        if (OPT_OUTS.some((k) => upper.includes(k))) {
            console.log(
                `[${reqId}] OPT-OUT detected from ${from} via body="${body}"`
            );
            // record opt-out; also keep an index set for easy viewing
            await Promise.all([
                redis.set(`optout:${from}`, '1', {ex: 60 * 60 * 24 * 365}), // 1 year
                redis.sadd('optedout:index', from),
            ]);
            // With Advanced Opt-Out ON, Twilio auto-replies and blocks future sends
            return res.status(204).end();
        }

        if (HELP_WORDS.some((k) => upper.includes(k))) {
            console.log(
                `[${reqId}] HELP received from ${from}; staying silent (Twilio may reply).`
            );
            // If you want to always return your HELP text, uncomment next 3 lines:
            twiml.message(
                'Robyn & Kingsley Wedding Website Password Auto Responder. Contact Kingsley for Assistance. Reply STOP to opt out.'
            );
            res.setHeader('Content-Type', 'text/xml');
            return res.status(200).send(twiml.toString());
            // return res.status(204).end();
        }

        // --- Re-opt-in handling ---
        // If they send START/UNSTOP/YES, clear our opt-out record.
        let clearedOptOut = false;
        if (OPT_INS.some((k) => upper.includes(k))) {
            await Promise.all([
                redis.del(`optout:${from}`),
                redis.srem('optedout:index', from),
            ]);
            clearedOptOut = true;
            console.log(
                `[${reqId}] OPT-IN via START/UNSTOP from ${from} (cleared optout).`
            );
            // We still *require* PASSWORD to proceed with the actual password flow below.
            // So keep going; keyword gate will ensure they include PASSWORD.
        }

        // If number is opted-out (per our record) and they didn't send a valid rejoin,
        // consider PASSWORD as a rejoin *if* explicitly allowed.
        const isOptedOut = await redis.get(`optout:${from}`);
        if (
            isOptedOut &&
            !clearedOptOut &&
            ALLOW_PASSWORD_REJOIN &&
            REQUIRE_KEYWORD &&
            upper.includes(REQUIRE_KEYWORD)
        ) {
            await Promise.all([
                redis.del(`optout:${from}`),
                redis.srem('optedout:index', from),
            ]);
            console.log(
                `[${reqId}] OPT-IN via PASSWORD from ${from} (cleared optout).`
            );
            // ⚠️ If Advanced Opt-Out is ON, Twilio/carrier may still block delivery until START.
            // If you see "21610" errors in Twilio logs, user must send START once.
        } else if (isOptedOut && !clearedOptOut) {
            console.log(
                `[${reqId}] Still opted-out; ignoring message from ${from}.`
            );
            return res.status(204).end();
        }

        // --- Keyword gate (REQUIRED for initial and ongoing handling) ---
        if (REQUIRE_KEYWORD && !upper.includes(REQUIRE_KEYWORD)) {
            console.log(
                `[${reqId}] Keyword gate failed. Required="${REQUIRE_KEYWORD}", got="${body}". 204.`
            );
            return res.status(204).end(); // silent -> no outbound SMS cost
        }

        // --- Whitelist check FIRST (guests bypass throttles) ---
        const isWhitelisted = await redis.sismember('whitelist', from);
        console.log(`[${reqId}] Whitelist`, {
            from: from,
            isWhitelisted,
        });

        if (isWhitelisted) {
            twiml.message(`Hi! Here’s the password: ${SITE_PASSWORD}`);

            // Optional: global cap even for guests (usually not needed)
            // const globalKey = `rl:global:${today}`;
            // const current = (await redis.get(globalKey)) ?? 0;
            // if (current >= GLOBAL_MAX_PER_DAY) {
            //   console.log(`[${reqId}] Global cap hit for WHITELIST (${GLOBAL_MAX_PER_DAY}). 204.`);
            //   return res.status(204).end();
            // }
            // await Promise.all([redis.incr(globalKey), redis.expire(globalKey, 172800)]);

            res.setHeader('Content-Type', 'text/xml');
            console.log(
                `[${reqId}] 200 WHITELIST in ${Date.now() - started}ms`
            );
            return res.status(200).send(twiml.toString());
        }

        // --- Unknown numbers: apply throttles + global cap ---
        const globalKey = `rl:global:${today}`;
        const countKey = `rl:num:${from}:${today}:count`;
        const lastKey = `rl:num:${from}:${today}:last`;

        const [globalCount, numberCount, lastMs] = await redis.mget(
            globalKey,
            countKey,
            lastKey
        );
        console.log(`[${reqId}] Throttle state`, {
            globalCount: globalCount ?? 0,
            numberCount: numberCount ?? 0,
            lastMs: lastMs ?? 0,
        });

        // Global cap (across everyone; protects budget)
        if ((globalCount ?? 0) >= GLOBAL_MAX_PER_DAY) {
            console.log(
                `[${reqId}] Global cap reached (${GLOBAL_MAX_PER_DAY}). 204.`
            );
            return res.status(204).end();
        }

        // Per-number cooldown + cap (unknowns only)
        const now = Date.now();
        const last = parseInt(lastMs ?? '0', 10);
        const minMillis = MIN_REPLY_COOLDOWN_MIN * 60 * 1000;

        if (last && now - last < minMillis) {
            console.log(
                `[${reqId}] Cooldown for ${from} ~${Math.ceil(
                    (minMillis - (now - last)) / 1000
                )}s left.`
            );
            return res.status(204).end();
        }
        if ((numberCount ?? 0) >= MAX_PER_NUMBER_PER_DAY) {
            console.log(`[${reqId}] Per-number cap reached for ${from}. 204.`);
            return res.status(204).end();
        }

        // Fallback for unknowns
        twiml.message(
            'We couldn’t match this number to our guest list. If this is a mistake, please contact Kingsley.'
        );

        // Record cost-bearing reply for throttling (unknowns only)
        await Promise.all([
            redis.incr(globalKey),
            redis.incr(countKey),
            redis.set(lastKey, String(now)),
            // 2-day expiry cleans up old counters automatically
            redis.expire(globalKey, 172800),
            redis.expire(countKey, 172800),
            redis.expire(lastKey, 172800),
        ]);

        res.setHeader('Content-Type', 'text/xml');
        console.log(
            `[${reqId}] 200 UNKNOWN Number in ${Date.now() - started}ms`
        );
        return res.status(200).send(twiml.toString());
    } catch (err) {
        console.error(`[${reqId}] ERROR`, {
            message: err?.message,
            stack: err?.stack,
        });
        return res.status(500).send(err ? err.message : 'Server Error');
    }
}
