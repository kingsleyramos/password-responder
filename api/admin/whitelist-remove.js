import {redis} from '../../lib/redis.js';
import {KEYS} from '../../lib/config.js';
import {assertE164US} from '../../lib/utils.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

export default async function handler(req, res) {
    const reqId = Math.random().toString(36).slice(2, 8);
    console.log(
        `[${reqId}] Incoming whitelist-remove: ${req.method} ${req.url}`
    );

    try {
        if (!ADMIN_TOKEN) {
            console.error(`[${reqId}] Missing ADMIN_TOKEN env`);
            return res.status(401);
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
            return res.status(401);
        }
        if (!phoneParam) {
            console.warn(`[${reqId}] Missing ?phone param`);
            return res.status(400).json({ok: false, error: 'Missing ?phone'});
        }

        const phone = assertE164US(phoneParam);
        console.log(`[${reqId}] Validated phone: ${phone}`);

        const removed = await redis.srem(KEYS.WHITELIST, phone);
        console.log(`[${reqId}] SREM ${KEYS.WHITELIST} → removed=${removed}`);

        return res.status(200).json({
            ok: true,
            phone,
            removed: removed === 1,
            message:
                removed === 1
                    ? 'Phone removed from whitelist.'
                    : 'Phone was not in whitelist.',
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
