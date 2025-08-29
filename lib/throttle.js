import {redis} from './redis.js';
import {TTL, KEYS} from './config.js';

export async function getUnknownThrottleState({from}) {
    const key = `${KEYS.PER_NUMBER_HASH_PREFIX}${from}`;
    const [countRaw, lastRaw] = await redis.hmget(key, 'count', 'last');
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
        redis.expire(key, TTL.PER_NUMBER_HASH),
    ]);
}
