import {redis} from './redis.js';

export async function runUnknownAbuseGuards({
    from,
    body,
    today,
    log = console,
}) {
    // US-only
    if (!/^\+1\d{10}$/.test(from)) {
        log.info('AbuseGuard: non-US', from);
        return {allow: false};
    }

    // blocklist
    if (await redis.get(`block:${from}`)) {
        log.info('AbuseGuard: blocklisted', from);
        return {allow: false};
    }

    // anomaly breaker
    const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
    const unkKey = `unkbucket:${bucket}`;
    const unkCount = (await redis.incr(unkKey)) ?? 0;
    await redis.expire(unkKey, 3600);
    if (unkCount > 100) await redis.set('defensive:mode', '1', {ex: 3600});
    if (await redis.get('defensive:mode')) {
        log.info('AbuseGuard: defensive mode active');
        return {allow: false};
    }

    // content sanity
    if (body.length > 160 || /\bhttps?:\/\//i.test(body)) {
        const badKey = `bad:${from}:${today}`;
        const badCount = (await redis.incr(badKey)) ?? 0;
        await redis.expire(badKey, 172800);
        if (badCount >= 5) {
            await redis.set(`block:${from}`, '1', {ex: 60 * 60 * 24 * 2});
            await redis.sadd('abuse:index', from);
            log.info('AbuseGuard: added blocklist', {from, badCount});
        } else {
            log.info('AbuseGuard: suspicious content', {from, badCount});
        }
        return {allow: false};
    }

    return {allow: true};
}
