import {redis} from './redis.js';

export async function getUnknownThrottleState({from, today}) {
    const globalKey = `rl:global:${today}`;
    const countKey = `rl:num:${from}:${today}:count`;
    const lastKey = `rl:num:${from}:${today}:last`;
    const [globalCount, numberCount, lastMs] = await redis.mget(
        globalKey,
        countKey,
        lastKey
    );
    return {
        globalKey,
        countKey,
        lastKey,
        globalCount: globalCount ?? 0,
        numberCount: numberCount ?? 0,
        lastMs: parseInt(lastMs ?? '0', 10),
    };
}

export async function recordUnknownReply({globalKey, countKey, lastKey, now}) {
    await Promise.all([
        redis.incr(globalKey),
        redis.incr(countKey),
        redis.set(lastKey, String(now)),
        redis.expire(globalKey, 172800),
        redis.expire(countKey, 172800),
        redis.expire(lastKey, 172800),
    ]);
}
