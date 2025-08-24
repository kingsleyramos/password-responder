import {twiml as TwiML} from 'twilio';
import {Redis} from '@upstash/redis';

// Upstash Redis client (Vercel pulls env automatically)
const redis = Redis.fromEnv();

// env
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
const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || '').toUpperCase(); // e.g. "PASSWORD"

function dayKey(date = new Date()) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 10);
}

export default async function handler(req, res) {
    if (req.method !== 'POST')
        return res.status(405).send('Method Not Allowed');

    // Parse Twilio's urlencoded body
    const rawBody = await new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => resolve(data));
    });
    const params = Object.fromEntries(new URLSearchParams(rawBody));

    const from = (params.From || '').trim();
    const body = (params.Body || '').trim();
    const upper = body.toUpperCase();
    const today = dayKey();

    const twiml = new TwiML.MessagingResponse();

    // STOP/HELP compliance
    if (upper.includes('STOP')) {
        twiml.message(
            'You’re opted out and won’t receive messages. Reply START to opt back in.'
        );
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send(twiml.toString());
    }
    if (upper.includes('HELP')) {
        twiml.message('Wedding info SMS helper. Reply STOP to opt out.');
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send(twiml.toString());
    }

    // Keyword gate (optional, saves $$)
    if (REQUIRE_KEYWORD && !upper.includes(REQUIRE_KEYWORD)) {
        return res.status(204).end();
    }

    // --- Rate limits ---
    const globalKey = `rl:global:${today}`;
    const countKey = `rl:num:${from}:${today}:count`;
    const lastKey = `rl:num:${from}:${today}:last`;

    const [globalCount, numberCount, lastMs] = await redis.mget(
        globalKey,
        countKey,
        lastKey
    );
    if ((globalCount ?? 0) >= GLOBAL_MAX_PER_DAY) return res.status(204).end();

    const now = Date.now();
    const last = parseInt(lastMs ?? '0', 10);
    const minMillis = MIN_REPLY_COOLDOWN_MIN * 60 * 1000;
    if (last && now - last < minMillis) return res.status(204).end();

    if ((numberCount ?? 0) >= MAX_PER_NUMBER_PER_DAY)
        return res.status(204).end();

    // --- Whitelist check ---
    // Manage whitelist via Upstash console:
    //   SADD whitelist +15551234567 +15557654321
    const isWhitelisted = await redis.sismember('whitelist', from);

    if (isWhitelisted) {
        twiml.message(
            `Thanks! Here’s the wedding site password: ${SITE_PASSWORD}`
        );
    } else {
        twiml.message(
            'We couldn’t match this number to our guest list. If this is a mistake, please text back your full name. 💌'
        );
    }

    // record reply
    await Promise.all([
        redis.incr(globalKey),
        redis.incr(countKey),
        redis.set(lastKey, String(now)),
        redis.expire(globalKey, 172800),
        redis.expire(countKey, 172800),
        redis.expire(lastKey, 172800),
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
}
