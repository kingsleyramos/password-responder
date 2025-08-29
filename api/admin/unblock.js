// Admin endpoint to unblock a number via URL.
// Usage (GET or POST):
//   https://<your-app>.vercel.app/api/admin/unblock?phone=555-123-4567&token=YOUR_TOKEN
//
// Env required:
//   ADMIN_UNBLOCK_TOKEN=some-long-random-string

import {redis} from '../../lib/redis.js';
import {KEYS} from '../../lib/config.js';

const ADMIN_TOKEN = process.env.ADMIN_UNBLOCK_TOKEN;

// Normalize common US formats to E.164 +1XXXXXXXXXX
function normalizeToE164US(input) {
    if (!input) throw new Error('No phone number provided');
    const trimmed = String(input).trim();

    if (/^\+1\d{10}$/.test(trimmed)) return trimmed; // already E.164

    const digits = trimmed.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`; // 10-digit US
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`; // 1 + 10

    throw new Error(
        `Invalid US number format: "${input}". Expected 10 digits, 11 digits starting with 1, or +1XXXXXXXXXX.`
    );
}

// Delete keys by SCAN (works on all @upstash/redis versions)
async function deleteByPattern(pattern, count = 200) {
    let deleted = 0;
    let cursor = 0;

    do {
        const resp = await redis.scan(cursor, {match: pattern, count});
        const next = Number(resp?.[0] ?? 0);
        const keys = Array.isArray(resp?.[1]) ? resp[1] : [];

        for (const k of keys) {
            await redis.del(k);
            deleted++;
            console.log(`Deleted key: ${k}`);
        }
        cursor = next;
    } while (cursor !== 0);

    return deleted;
}

export default async function handler(req, res) {
    const reqId = Math.random().toString(36).slice(2, 8);
    console.log(
        `[${reqId}] Incoming unblock request: ${req.method} ${req.url}`
    );

    try {
        if (!ADMIN_TOKEN) {
            console.error(`[${reqId}] Missing ADMIN_UNBLOCK_TOKEN env`);
            return res.status(401).send('Unauthorized');
        }

        const isGet = req.method === 'GET';
        const isPost = req.method === 'POST';
        if (!isGet && !isPost) {
            console.warn(`[${reqId}] Unsupported method: ${req.method}`);
            return res
                .status(405)
                .json({ok: false, error: 'Method Not Allowed'});
        }

        let phoneParam, tokenParam;
        if (isGet) {
            phoneParam = req.query.phone;
            tokenParam = req.query.token;
        } else {
            const raw = await new Promise((resolve) => {
                let data = '';
                req.on('data', (c) => (data += c));
                req.on('end', () => resolve(data));
            });
            const params = Object.fromEntries(new URLSearchParams(raw));
            phoneParam = params.phone;
            tokenParam = params.token;
        }

        console.log(`[${reqId}] Parsed params`, {
            phoneParam,
            tokenParam: tokenParam ? '<present>' : '<missing>',
        });

        if (!tokenParam || tokenParam !== ADMIN_TOKEN) {
            console.warn(
                `[${reqId}] Unauthorized attempt with token="${tokenParam}"`
            );
            return res.status(401).send('Unauthorized');
        }
        if (!phoneParam) {
            console.warn(`[${reqId}] Missing ?phone param`);
            return res.status(400).json({error: 'Missing ?phone'});
        }

        const phone = normalizeToE164US(phoneParam);
        console.log(`[${reqId}] Normalized phone: ${phone}`);

        // 1) Remove from permanent blocklist
        const removed = await redis.srem(KEYS.ABUSE_SET, phone);
        console.log(`[${reqId}] SREM ${KEYS.ABUSE_SET} → removed=${removed}`);

        // 2) Remove per-number throttle hash
        const hashKey = `${KEYS.PER_NUMBER_HASH_PREFIX}${phone}`;
        await redis.del(hashKey);
        console.log(`[${reqId}] DEL ${hashKey}`);

        // 3) Remove burst counters
        const burstDeleted = await deleteByPattern(
            `${KEYS.BURST_PREFIX}${phone}:*`,
            200
        );
        console.log(`[${reqId}] Burst keys deleted: ${burstDeleted}`);

        console.log(`[${reqId}] ✅ Completed unblock for ${phone}`);

        return res.status(200).json({
            ok: true,
            phone,
            removedFromBlocklist: removed === 1,
            burstDeleted,
            note: 'If the user texted STOP, carriers still require START to re-enable delivery.',
        });
    } catch (err) {
        console.error(`[${reqId}] ERROR`, {
            message: err?.message,
            stack: err?.stack,
        });
        return res
            .status(400)
            .json({ok: false, error: err?.message || String(err)});
    }
}
