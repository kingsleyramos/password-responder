// lib/throttle.js — robust across @upstash/redis versions
import {redis} from './redis.js';

const HASH_TTL_SEC = 3 * 24 * 60 * 60; // 3 days

export async function getUnknownThrottleState({from}) {
    const key = `rl:num:${from}`;

    // Use two hget calls (always returns a single value or null)
    const [countRaw, lastRaw] = await Promise.all([
        redis.hget(key, 'count'),
        redis.hget(key, 'last'),
    ]);

    return {
        key,
        numberCount: Number(countRaw ?? 0),
        lastMs: Number(lastRaw ?? 0),
    };
}

export async function recordUnknownReply({key, now}) {
    await Promise.all([
        redis.hincrby(key, 'count', 1),
        redis.hset(key, {last: String(now)}),
        redis.expire(key, HASH_TTL_SEC),
    ]);
}
