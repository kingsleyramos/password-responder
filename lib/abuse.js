import {redis} from './redis.js';
import {KEYS, ABUSE, US_ONLY} from './config.js';

async function incrementGlobalUnknown(log = console) {
    const key = KEYS.UNKNOWN_WINDOW;
    const count = (await redis.incr(key)) ?? 0;
    if (count === 1) {
        await redis.expire(key, ABUSE.UNKNOWN_WINDOW_MINUTES * 60);
    }
    if (count > ABUSE.UNKNOWN_MESSAGE_THRESHOLD) {
        await redis.set(KEYS.DEFENSIVE_MODE, '1', {
            ex: ABUSE.DEFENSIVE_MODE_DURATION_SEC,
        });
        log.warn('AbuseGuard: defensive mode ENABLED', {count});
    }
    return count;
}

async function isBlocked(phoneNumber) {
    return !!(await redis.sismember(KEYS.ABUSE_SET, phoneNumber));
}

async function permanentlyBlock(phoneNumber, log = console) {
    await redis.sadd(KEYS.ABUSE_SET, phoneNumber);
    // light cleanup of burst counters & per-number hash fields
    for await (const key of redis.scanIterator({
        match: `${KEYS.BURST_PREFIX}${phoneNumber}:*`,
        count: 200,
    })) {
        await redis.del(key);
    }
    await redis.hdel(
        `${KEYS.PER_NUMBER_HASH_PREFIX}${phoneNumber}`,
        'count',
        'last',
        'suspicious'
    );
    log.info('AbuseGuard: permanently blocked (abuse:index)', {phoneNumber});
}

async function incrSuspicious(phoneNumber) {
    const key = `${KEYS.PER_NUMBER_HASH_PREFIX}${phoneNumber}`;
    const n = (await redis.hincrby(key, 'suspicious', 1)) ?? 0;
    // reuse PER_NUMBER_HASH TTL if you want, or set a small one here; leaving to main writer
    await redis.expire(key, 3 * 24 * 60 * 60);
    return n;
}

export async function runUnknownAbuseGuards({
    from: phoneNumber,
    body: messageBody,
    log = console,
}) {
    // 1) Country/format gate
    if (US_ONLY && !/^\+1\d{10}$/.test(phoneNumber)) {
        log.info('AbuseGuard: reject non-US', {phoneNumber});
        return {allow: false};
    }

    // 2) Permanent blocklist
    if (await isBlocked(phoneNumber)) {
        log.info('AbuseGuard: reject (abuse:index)', {phoneNumber});
        return {allow: false};
    }

    // 3) Per-number burst guard
    if (ABUSE.MAX_MESSAGES_PER_NUMBER > 0) {
        const bucket = Math.floor(
            Date.now() / (ABUSE.BURST_WINDOW_SECONDS * 1000)
        );
        const burstKey = `${KEYS.BURST_PREFIX}${phoneNumber}:${bucket}`;
        const burstCount = (await redis.incr(burstKey)) ?? 0;
        if (burstCount === 1) {
            await redis.expire(burstKey, ABUSE.BURST_WINDOW_SECONDS + 30);
        }
        if (burstCount > ABUSE.MAX_MESSAGES_PER_NUMBER) {
            await permanentlyBlock(phoneNumber, log);
            return {allow: false};
        }
    }

    // 4) Global anomaly breaker
    await incrementGlobalUnknown(log);
    if (await redis.get(KEYS.DEFENSIVE_MODE)) {
        log.info('AbuseGuard: defensive mode reject', {phoneNumber});
        return {allow: false};
    }

    // 5) Suspicious content (too long or contains URL)
    if (
        messageBody.length > ABUSE.MAX_MESSAGE_LENGTH ||
        ABUSE.URL_PATTERN.test(messageBody)
    ) {
        const badCount = await incrSuspicious(phoneNumber);
        if (badCount >= 5) {
            await permanentlyBlock(phoneNumber, log);
        } else {
            log.info('AbuseGuard: suspicious message rejected', {
                phoneNumber,
                badCount,
            });
        }
        return {allow: false};
    }

    return {allow: true};
}
