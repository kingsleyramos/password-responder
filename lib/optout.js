import {redis} from './redis.js';

export async function recordOptOut(phone) {
    await Promise.all([
        redis.set(`optout:${phone}`, '1', {ex: 60 * 60 * 24 * 365}), // 1 year local record
        redis.sadd('optedout:index', phone),
    ]);
}

export async function clearOptOut(phone) {
    await Promise.all([
        redis.del(`optout:${phone}`),
        redis.srem('optedout:index', phone),
    ]);
}

export async function isOptedOut(phone) {
    return !!(await redis.get(`optout:${phone}`));
}
