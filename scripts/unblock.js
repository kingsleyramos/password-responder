// Unblock a phone number (remove from abuse:index) with flexible input formats.
// Requirements:
//   - Local .env with: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   - Deps: @upstash/redis, dotenv
//
// What it does:
//   1) SREM from abuse:index (permanent blocklist)
//   2) DEL rl:num:<phone> (per-number throttle hash)
//   3) SCAN+DEL burst:<phone>:* (any burst counters)
//
// Usage:
//   node scripts/unblock.mjs 5551234567
//
// | Example Input    | What the script sees (after stripping)   | Normalized Output |
// | ---------------- | ---------------------------------------- | ----------------- |
// | `5551234567`     | `5551234567` (10 digits)                 | `+15551234567`    |
// | `(555) 123-4567` | `5551234567` (10 digits)                 | `+15551234567`    |
// | `555-123-4567`   | `5551234567` (10 digits)                 | `+15551234567`    |
// | `555.123.4567`   | `5551234567` (10 digits)                 | `+15551234567`    |
// | `555 123 4567`   | `5551234567` (10 digits)                 | `+15551234567`    |
// | `1-555-123-4567` | `15551234567` (11 digits, starts with 1) | `+15551234567`    |
// | `15551234567`    | `15551234567` (11 digits, starts with 1) | `+15551234567`    |
// | `+15551234567`   | Already in E.164                         | `+15551234567`    |

import 'dotenv/config';
import {Redis} from '@upstash/redis';
import {KEYS} from '../lib/config.js';

const redis = Redis.fromEnv();

function normalizeToE164US(input) {
    if (!input) throw new Error('No phone number provided');
    const trimmed = String(input).trim();

    // Already looks like +1XXXXXXXXXX?
    if (/^\+1\d{10}$/.test(trimmed)) return trimmed;

    // Strip non-digits
    const digits = trimmed.replace(/\D/g, '');

    // 10 digits -> assume US, add +1
    if (digits.length === 10) return `+1${digits}`;

    // 11 digits starting with 1 -> add leading +
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

    throw new Error(
        `Invalid US number format: "${input}". Expected 10 digits, 11 digits starting with 1, or +1XXXXXXXXXX.`
    );
}

async function unblock(phoneE164) {
    // 1) Remove from permanent blocklist
    const removed = await redis.srem(KEYS.ABUSE_SET, phoneE164);

    // 2) Remove per-number throttle hash
    await redis.del(`${KEYS.PER_NUMBER_HASH_PREFIX}${phoneE164}`);

    // 3) Remove any burst counters
    let burstDeleted = 0;
    for await (const key of redis.scanIterator({
        match: `${KEYS.BURST_PREFIX}${phoneE164}:*`,
        count: 200,
    })) {
        await redis.del(key);
        burstDeleted++;
    }

    // Result message
    if (removed) {
        console.log(
            `✅ Unblocked ${phoneE164} — removed from "${KEYS.ABUSE_SET}", deleted throttle hash, burstDeleted=${burstDeleted}`
        );
    } else {
        console.log(
            `ℹ️ ${phoneE164} was not present in "${KEYS.ABUSE_SET}". Throttle hash cleared, burstDeleted=${burstDeleted}`
        );
    }
}

(async () => {
    try {
        const arg = process.argv[2];
        if (!arg) {
            console.error('Usage: node scripts/unblock.mjs <phone number>');
            process.exit(1);
        }
        const phone = normalizeToE164US(arg);
        await unblock(phone);
        process.exit(0);
    } catch (err) {
        console.error(`❌ ${err?.message || err}`);
        process.exit(1);
    }
})();
