/*eslint no-process-env: "error"*/
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
import { twiml as TwiML } from 'twilio';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'PASSWORD';
const MIN_REPLY_COOLDOWN_MIN = parseInt(process.env.MIN_REPLY_COOLDOWN_MIN ?? '3', 10);
const MAX_PER_NUMBER_PER_DAY = parseInt(process.env.MAX_PER_NUMBER_PER_DAY ?? '3', 10);
const GLOBAL_MAX_PER_DAY = parseInt(process.env.GLOBAL_MAX_PER_DAY ?? '2000', 10);
const REQUIRE_KEYWORD = (process.env.REQUIRE_KEYWORD || '').toUpperCase();

function dayKey(date = new Date()) {
  // Use local-day boundary by removing TZ offset from ISO date
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD
}

export default async function handler(req, res) {
  console.log('HIT');
  const reqId = Math.random().toString(36).slice(2, 8);

  try {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    // Parse application/x-www-form-urlencoded (Twilio default)
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

    // --- STOP/HELP compliance (keeps your number healthy) ---
    if (upper.includes('STOP')) {
      twiml.message('You’re opted out and won’t receive messages. Reply START to opt back in.');
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml.toString());
    }
    if (upper.includes('HELP')) {
      twiml.message('Wedding info SMS helper. Reply STOP to opt out.');
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml.toString());
    }

    // --- Optional keyword gate (applies to everyone) ---
    if (REQUIRE_KEYWORD && !upper.includes(REQUIRE_KEYWORD)) {
      return res.status(204).end(); // No reply = no outbound SMS cost
    }

    // --- Whitelist check FIRST (guests bypass throttles) ---
    const isWhitelisted = await redis.sismember('whitelist', from);

    if (isWhitelisted) {
      twiml.message(`Hi! Here’s password to robyn-kingsley.wedding: ${SITE_PASSWORD}`);

      // Optional: global cap even for guests (leave commented unless you want it)
      const globalKey = `rl:global:${today}`;
      const current = (await redis.get(globalKey)) ?? 0;
      if (current >= GLOBAL_MAX_PER_DAY) {
        console.log(`[${reqId}] Global cap hit for WHITELIST (${GLOBAL_MAX_PER_DAY}). 204.`);
        return res.status(204).end();
      }
      await Promise.all([redis.incr(globalKey), redis.expire(globalKey, 172800)]);

      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml.toString());
    }

    // --- Unknown numbers: apply throttles + global cap ---
    const globalKey = `rl:global:${today}`;
    const countKey = `rl:num:${from}:${today}:count`;
    const lastKey = `rl:num:${from}:${today}:last`;

    const [globalCount, numberCount, lastMs] = await redis.mget(globalKey, countKey, lastKey);

    // Global cap (across everyone; protects budget)
    if ((globalCount ?? 0) >= GLOBAL_MAX_PER_DAY) {
      return res.status(204).end();
    }

    // Per-number cooldown + cap (unknowns only)
    const now = Date.now();
    const last = parseInt(lastMs ?? '0', 10);
    const minMillis = MIN_REPLY_COOLDOWN_MIN * 60 * 1000;
    if (last && now - last < minMillis) {
      return res.status(204).end();
    }
    if ((numberCount ?? 0) >= MAX_PER_NUMBER_PER_DAY) {
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
    return res.status(200).send(twiml.toString());
  } catch (err) {
    return res.status(500).send( err ? err?.message : 'Server Error');
  }
}
