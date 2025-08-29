// lib/abuse.js
import {redis} from './redis.js';

/* ---------------------- Tunable thresholds ---------------------- */

// Global anomaly breaker (unknown volume in rolling window)
const UNKNOWN_WINDOW_MINUTES = 5; // size of rolling window
const UNKNOWN_MESSAGE_THRESHOLD = 20; // max unknown messages allowed per window
const DEFENSIVE_MODE_DURATION_SEC = 3600 * 6; // 1 hour * 6 defensive mode lockout

// Per-number burst guard
const MAX_MESSAGES_PER_NUMBER = 5; // max messages allowed per number
const BURST_WINDOW_SECONDS = 60; // in this many seconds

// Content sanity checks
const MAX_MESSAGE_LENGTH = 16; // reject if >160 chars
const URL_PATTERN = /\bhttps?:\/\//i; // reject if contains URL

/* ----------------------------- Helpers ----------------------------- */

async function permanentlyBlockNumber(phoneNumber) {
    await Promise.all([
        redis.set(`block:${phoneNumber}`, '1'), // permanent block
        redis.sadd('abuse:index', phoneNumber), // add to list of abusers
    ]);
}

/* ------------------------- Main Guard ------------------------------ */

export async function runUnknownAbuseGuards({
    from: phoneNumber,
    body: messageBody,
    today,
    log = console,
}) {
    // 1) Restrict to US numbers only (E.164 format)
    if (!/^\+1\d{10}$/.test(phoneNumber)) {
        log.info('AbuseGuard: rejected non-US number', {phoneNumber});
        return {allow: false};
    }

    // 2) Blocklisted numbers
    if (await redis.get(`block:${phoneNumber}`)) {
        log.info('AbuseGuard: rejected blocklisted number', {phoneNumber});
        return {allow: false};
    }

    // 3) Per-number burst guard
    if (MAX_MESSAGES_PER_NUMBER > 0 && BURST_WINDOW_SECONDS > 0) {
        const currentBurstWindow = Math.floor(
            Date.now() / (BURST_WINDOW_SECONDS * 1000)
        );
        const burstCounterKey = `burst:${phoneNumber}:${currentBurstWindow}`;
        const currentBurstCount = (await redis.incr(burstCounterKey)) ?? 0;

        await redis.expire(burstCounterKey, BURST_WINDOW_SECONDS + 60);

        if (currentBurstCount > MAX_MESSAGES_PER_NUMBER) {
            await permanentlyBlockNumber(phoneNumber);
            log.info('AbuseGuard: permanently blocked for burst abuse', {
                phoneNumber,
                currentBurstCount,
            });
            return {allow: false};
        }
    }

    // 4) Global anomaly breaker (detect floods of unknowns)
    const currentFloodWindow = Math.floor(
        Date.now() / (UNKNOWN_WINDOW_MINUTES * 60 * 1000)
    );
    const globalUnknownCounterKey = `unknownFlood:${currentFloodWindow}`;
    const globalUnknownCount = (await redis.incr(globalUnknownCounterKey)) ?? 0;

    await redis.expire(
        globalUnknownCounterKey,
        UNKNOWN_WINDOW_MINUTES * 60 + 300
    );

    if (globalUnknownCount > UNKNOWN_MESSAGE_THRESHOLD) {
        await redis.set('defensive:mode', '1', {
            ex: DEFENSIVE_MODE_DURATION_SEC,
        });
        log.warn('AbuseGuard: defensive mode ENABLED (too many unknowns)', {
            globalUnknownCount,
            UNKNOWN_WINDOW_MINUTES,
        });
    }

    if (await redis.get('defensive:mode')) {
        log.info('AbuseGuard: rejected due to defensive mode', {phoneNumber});
        return {allow: false};
    }

    // 5) Content sanity checks (message length or suspicious URL)
    if (
        messageBody.length > MAX_MESSAGE_LENGTH ||
        URL_PATTERN.test(messageBody)
    ) {
        const suspiciousContentKey = `suspicious:${phoneNumber}:${today}`;
        const suspiciousCount = (await redis.incr(suspiciousContentKey)) ?? 0;
        await redis.expire(suspiciousContentKey, 172800); // 2 days

        if (suspiciousCount >= 5) {
            await permanentlyBlockNumber(phoneNumber);
            log.info(
                'AbuseGuard: permanently blocked due to repeated suspicious content',
                {phoneNumber, suspiciousCount}
            );
        } else {
            log.info('AbuseGuard: rejected suspicious message', {
                phoneNumber,
                suspiciousCount,
            });
        }
        return {allow: false};
    }

    // All guards passed
    return {allow: true};
}
