// scripts/unblock.mjs
// Unblock a phone number from opt-out and abuse throttles in Upstash Redis.
//
// Usage:
//   node scripts/unblock.js +15551234567
//   node scripts/unblock.js 5551234567
//   node scripts/unblock.js +15551234567 --all   # also remove historical rate-limit keys
//
// Requirements:
//   - UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN in your local .env
//   - npm i @upstash/redis dotenv
//
// Tip: add an npm script:
//   "scripts": { "unblock": "node scripts/unblock.mjs" }
//   Then run: npm run unblock -- +15551234567

import 'dotenv/config';
import {Redis} from '@upstash/redis';

const redis = Redis.fromEnv();

function dayKey(date = new Date()) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 10);
}

function normalizeUS(input) {
    const raw = (input || '').trim();
    if (!raw) return null;
    if (raw.startsWith('+')) return raw; // assume already E.164
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null; // not a recognizable US/CA number
}

async function scanDelete(pattern) {
    // Iterates keys matching pattern and deletes them.
    // Upstash supports SCAN + DEL; @upstash/redis provides scanIterator
    let deleted = 0;
    for await (const key of redis.scanIterator({match: pattern, count: 200})) {
        await redis.del(key);
        deleted++;
    }
    return deleted;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node scripts/unblock.mjs <phone> [--all]');
        process.exit(1);
    }
    const wantsAll = args.includes('--all');
    const phoneArg = args.find((a) => !a.startsWith('--'));
    const phone = normalizeUS(phoneArg);

    if (!phone) {
        console.error(
            'Error: please provide a US/CA phone number (e.g., +15551234567 or 5551234567).'
        );
        process.exit(1);
    }

    console.log(
        `Unblocking ${phone} ${
            wantsAll ? '(FULL --all)' : '(today only for rate-limit keys)'
        }...`
    );

    // 1) Clear opt-out state
    await Promise.allSettled([
        redis.del(`optout:${phone}`),
        redis.srem('optedout:index', phone),
    ]);
    console.log('✓ Cleared opt-out flags');

    // 2) Clear temporary blocklist & abuse index
    await Promise.allSettled([
        redis.del(`block:${phone}`),
        redis.srem('abuse:index', phone),
    ]);
    console.log('✓ Cleared blocklist flags');

    // 3) Clear rate-limit counters
    if (wantsAll) {
        const del1 = await scanDelete(`rl:num:${phone}:*:count`);
        const del2 = await scanDelete(`rl:num:${phone}:*:last`);
        const del3 = await scanDelete(`bad:${phone}:*`);
        console.log(
            `✓ Deleted historical rate-limit keys: count=${del1}, last=${del2}, bad=${del3}`
        );
    } else {
        const today = dayKey();
        await Promise.allSettled([
            redis.del(`rl:num:${phone}:${today}:count`),
            redis.del(`rl:num:${phone}:${today}:last`),
            redis.del(`bad:${phone}:${today}`),
        ]);
        console.log("✓ Cleared today's rate-limit keys (count/last/bad)");
    }

    console.log(
        '✅ Done. If the user previously sent STOP and Advanced Opt-Out is ON, they must text START once to re-enable carrier delivery.'
    );
}

main().catch((err) => {
    console.error('Unblock script failed:', err?.message || err);
    process.exit(1);
});
