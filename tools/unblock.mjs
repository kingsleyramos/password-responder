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
//   node scripts/unblock.mjs 6195732332
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
import {redis} from '../lib/redis.js';
import {KEYS} from '../lib/config.js';
import {normalizeToE164US} from '../../lib/utils.js';

// Delete keys matching a pattern, supporting both scanIterator (new) and SCAN loop (old)
async function deleteByPattern(pattern, count = 200) {
    let deleted = 0;

    if (typeof redis.scanIterator === 'function') {
        // Newer client: async iterator
        for await (const key of redis.scanIterator({match: pattern, count})) {
            await redis.del(key);
            deleted++;
        }
        return deleted;
    }

    // Fallback: manual SCAN pagination
    let cursor = 0;
    do {
        const resp = await redis.scan(cursor, {match: pattern, count});
        // Upstash returns [nextCursor, keys[]]
        const nextCursor =
            typeof resp?.[0] !== 'undefined' ? Number(resp[0]) : 0;
        const keys = Array.isArray(resp?.[1]) ? resp[1] : [];

        if (keys.length) {
            // Delete sequentially (safe). You could batch/pipeline if desired.
            for (const k of keys) {
                await redis.del(k);
                deleted++;
            }
        }
        cursor = nextCursor;
    } while (cursor !== 0);

    return deleted;
}

async function unblock(phoneE164) {
    // 1) Remove from permanent blocklist
    const removed = await redis.srem(KEYS.ABUSE_SET, phoneE164);

    // 2) Remove per-number throttle hash
    await redis.del(`${KEYS.PER_NUMBER_HASH_PREFIX}${phoneE164}`);

    // 3) Remove any burst counters (supports old/new client)
    const burstDeleted = await deleteByPattern(
        `${KEYS.BURST_PREFIX}${phoneE164}:*`,
        200
    );

    if (removed) {
        console.log(
            `✅ Unblocked ${phoneE164}: removed from "${KEYS.ABUSE_SET}", cleared throttle hash, burstDeleted=${burstDeleted}`
        );
    } else {
        console.log(
            `ℹ️ ${phoneE164} not found in "${KEYS.ABUSE_SET}". Cleared counters anyway (burstDeleted=${burstDeleted}).`
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
        console.log(`Normalizing → ${phone}`);
        await unblock(phone);
        process.exit(0);
    } catch (err) {
        console.error(`❌ ${err?.message || err}`);
        process.exit(1);
    }
})();
