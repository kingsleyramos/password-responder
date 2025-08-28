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

function maskPhone(p) {
  if (!p || p.length < 6) return p || '';
  // E.164 like +15551234567 -> +1•••123••67 (light mask)
  return p.replace(/^(\+\d)(\d{3})(\d+)(\d{2})$/, (_, a, b, mid, c) => `${a}${'•'.repeat(b.length)}${mid.slice(0,3)}${'•'.repeat(Math.max(0, mid.length-5))}${c}`);
}

export default async function handler(req, res) {
  const reqId = Math.random().toString(36).slice(2, 8);
  const started = Date.now();

  try {
    if (req.method !== 'POST') {
      console.warn(`[${reqId}] Non-POST request`, { method: req.method, url: req.url });
      return res.status(405).send('Method Not Allowed');
    }

    // Parse application/x-www-form-urlencoded (Twilio default)
    const rawBody = await new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
    });

    console.log(`[${reqId}] Incoming webhook`, {
      url: req.url,
      headers: {
        'content-type': req.headers['content-type'],
        'x-twilio-signature': req.headers['x-twilio-signature'] ? '<present>' : '<absent>',
      },
      rawLen: rawBody.length,
    });

    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const from = (params.From || '').trim();
    const body = (params.Body || '').trim();
    const upper = body.toUpperCase();
    const today = dayKey();
    const messageSid = params.MessageSid || '';

    console.log(`[${reqId}] Parsed params`, {
      From: maskPhone(from),
      BodyPreview: body.slice(0, 80),
      MessageSid: messageSid,
      Today: today,
    });

    const twiml = new TwiML.MessagingResponse();

    // --- STOP/HELP compliance (keeps your number healthy) ---
    if (upper.includes('STOP')) {
      console.log(`[${reqId}] STOP received from ${maskPhone(from)}`);
      twiml.message('You’re opted out and won’t receive messages. Reply START to opt back in.');
      res.setHeader('Content-Type', 'text/xml');
      console.log(`[${reqId}] Responding 200 STOP in ${Date.now() - started}ms`);
      return res.status(200).send(twiml.toString());
    }
    if (upper.includes('HELP')) {
      console.log(`[${reqId}] HELP received from ${maskPhone(from)}`);
      twiml.message('Wedding info SMS helper. Reply STOP to opt out.');
      res.setHeader('Content-Type', 'text/xml');
      console.log(`[${reqId}] Responding 200 HELP in ${Date.now() - started}ms`);
      return res.status(200).send(twiml.toString());
    }

    // --- Optional keyword gate (applies to everyone) ---
    if (REQUIRE_KEYWORD && !upper.includes(REQUIRE_KEYWORD)) {
      console.log(
        `[${reqId}] Keyword gate failed. Required="${REQUIRE_KEYWORD}", from=${maskPhone(from)}`
      );
      return res.status(204).end(); // No reply = no outbound SMS cost
    }

    // --- Whitelist check FIRST (guests bypass throttles) ---
    const isWhitelisted = await redis.sismember('whitelist', from);
    console.log(`[${reqId}] Whitelist`, { from: maskPhone(from), isWhitelisted });

    if (isWhitelisted) {
      twiml.message(`Hi! Here’s password to robyn-kingsley.wedding: ${SITE_PASSWORD}`);

      // Optional: global cap even for guests (leave commented unless you want it)
      // const globalKey = `rl:global:${today}`;
      // const current = (await redis.get(globalKey)) ?? 0;
      // if (current >= GLOBAL_MAX_PER_DAY) {
      //   console.log(`[${reqId}] Global cap hit for WHITELIST (${GLOBAL_MAX_PER_DAY}). 204.`);
      //   return res.status(204).end();
      // }
      // await Promise.all([redis.incr(globalKey), redis.expire(globalKey, 172800)]);

      res.setHeader('Content-Type', 'text/xml');
      console.log(`[${reqId}] Responding 200 WHITELIST in ${Date.now() - started}ms`);
      return res.status(200).send(twiml.toString());
    }

    // --- Unknown numbers: apply throttles + global cap ---
    const globalKey = `rl:global:${today}`;
    const countKey = `rl:num:${from}:${today}:count`;
    const lastKey = `rl:num:${from}:${today}:last`;

    const [globalCount, numberCount, lastMs] = await redis.mget(globalKey, countKey, lastKey);
    console.log(`[${reqId}] Throttle state (unknown)`, {
      globalCount: globalCount ?? 0,
      numberCount: numberCount ?? 0,
      lastMs: lastMs ?? 0,
    });

    // Global cap (across everyone; protects budget)
    if ((globalCount ?? 0) >= GLOBAL_MAX_PER_DAY) {
      console.log(`[${reqId}] Global cap reached (${GLOBAL_MAX_PER_DAY}). 204.`);
      return res.status(204).end();
    }

    // Per-number cooldown + cap (unknowns only)
    const now = Date.now();
    const last = parseInt(lastMs ?? '0', 10);
    const minMillis = MIN_REPLY_COOLDOWN_MIN * 60 * 1000;
    if (last && now - last < minMillis) {
      console.log(
        `[${reqId}] Cooldown active for ${maskPhone(from)}. Remaining ~${Math.ceil(
          (minMillis - (now - last)) / 1000
        )}s`
      );
      return res.status(204).end();
    }
    if ((numberCount ?? 0) >= MAX_PER_NUMBER_PER_DAY) {
      console.log(
        `[${reqId}] Per-number daily cap reached for ${maskPhone(from)} (${MAX_PER_NUMBER_PER_DAY}). 204.`
      );
      return res.status(204).end();
    }

    // Fallback for unknowns
    twiml.message(
      'We couldn’t match this number to our guest list. If this is a mistake, please contact Kingsley'
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
    console.log(`[${reqId}] Responding 200 UNKNOWN in ${Date.now() - started}ms`);
    return res.status(200).send(twiml.toString());
  } catch (err) {
    console.error(`[${reqId}] ERROR`, { message: err?.message, stack: err?.stack });
    return res.status(500).send('Server Error');
  }
}
