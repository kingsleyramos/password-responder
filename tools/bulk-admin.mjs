#!/usr/bin/env node
/**
 * Bulk admin CLI that normalizes US phone numbers and calls your Vercel API.
 *
 * Usage:
 *   # single / multiple on the command line
 *   ADMIN_BASE_URL=... ADMIN_TOKEN=... node tools/bulk-admin.mjs unblock 619-555-1234 (619)555-6789
 *   ADMIN_BASE_URL=... ADMIN_TOKEN=... node tools/bulk-admin.mjs whitelist-add 6195551234 +16195556789
 *   ADMIN_BASE_URL=... ADMIN_TOKEN=... node tools/bulk-admin.mjs whitelist-remove 619.555.7777
 *
 *   # from a file (newline, comma, tab, semicolon; comments # or //)
 *   ADMIN_BASE_URL=... ADMIN_TOKEN=... node tools/bulk-admin.mjs unblock --file phones.txt
 *
 * Options:
 *   --file <path>         read numbers from file
 *   --concurrency=N       parallel requests (default 5)
 *   --dry-run             print normalized numbers and exit (no network)
 *
 * Env:
 *   ADMIN_BASE_URL        e.g. https://your-app.vercel.app   (no trailing slash)
 *   ADMIN_TOKEN           same secret your API checks (e.g. ADMIN_UNBLOCK_TOKEN)
 */
import dotenv from 'dotenv';
dotenv.config({path: '../.env'});

const BASE = process.env.ADMIN_BASE_URL;
const TOKEN = process.env.ADMIN_TOKEN;

if (!BASE || !TOKEN) {
    console.error(
        `Missing env. Set ADMIN_BASE_URL and ADMIN_TOKEN.

Example:
  ADMIN_BASE_URL="https://your-app.vercel.app" ADMIN_TOKEN="xxxx" node tools/bulk-admin.mjs unblock 619-555-1234
`
    );
    process.exit(1);
}

const COMMANDS = new Set(['unblock', 'whitelist-add', 'whitelist-remove']);
const args = process.argv.slice(2);
const action = args[0];

if (!COMMANDS.has(action)) {
    console.error(
        `First arg must be one of: ${Array.from(COMMANDS).join(', ')}`
    );
    process.exit(1);
}

function getFlag(name, def = undefined) {
    const hit = args.find(
        (a) => a === `--${name}` || a.startsWith(`--${name}=`)
    );
    if (!hit) return def;
    if (hit.includes('=')) return hit.split('=')[1];
    return true;
}

const filePath = getFlag('file', null);
const dryRun = !!getFlag('dry-run', false);
const concurrency = Number(getFlag('concurrency', 5));
const trailing = args.slice(1).filter((a) => !a.startsWith('--')); // direct phone args

/** Normalize common US formats to E.164 +1XXXXXXXXXX */
function normalizeToE164US(input) {
    if (!input) throw new Error('No phone number provided');
    const trimmed = String(input).trim();

    if (/^\+1\d{10}$/.test(trimmed)) return trimmed; // already E.164

    const digits = trimmed.replace(/\D/g, ''); // strip non-digits ((), -, spaces, dots)
    if (digits.length === 10) return `+1${digits}`; // 10-digit US
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`; // 1 + 10

    throw new Error(
        `Invalid US number format: "${input}". Expected 10 digits, 11 digits starting with 1, or +1XXXXXXXXXX.`
    );
}

/** parse file/args blob into unique list (order preserved) */
function parsePhonesBlob(blob) {
    const raw = String(blob || '');
    const tokens = raw
        .split(/\r?\n|,|;|\t/g)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !s.startsWith('#') && !s.startsWith('//'));
    const seen = new Set();
    const out = [];
    for (const t of tokens) {
        if (!seen.has(t)) {
            seen.add(t);
            out.push(t);
        }
    }
    return out;
}

async function readPhones() {
    if (filePath) {
        const fs = await import('node:fs/promises');
        const data = await fs.readFile(
            typeof filePath === 'string' ? filePath : trailing[0],
            'utf8'
        );
        return parsePhonesBlob(data);
    }
    return parsePhonesBlob(trailing.join(' '));
}

function endpointFor(action) {
    switch (action) {
        case 'unblock':
            return '/api/admin/unblock';
        case 'whitelist-add':
            return '/api/admin/whitelist-add';
        case 'whitelist-remove':
            return '/api/admin/whitelist-remove';
        default:
            throw new Error(`Unknown action ${action}`);
    }
}

async function callEndpoint(action, phone) {
    const url = `${BASE}${endpointFor(action)}`;
    const body = new URLSearchParams({phone, token: TOKEN}).toString();
    const resp = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body,
    });
    const text = await resp.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = {raw: text};
    }
    if (!resp.ok) {
        throw new Error(
            `HTTP ${resp.status} ${resp.statusText} → ${json?.error || text}`
        );
    }
    return json;
}

/** tiny concurrency pool */
async function runPool(items, worker, limit = 5) {
    const results = [];
    let idx = 0;
    let active = 0;
    return new Promise((resolve) => {
        const next = () => {
            if (idx >= items.length && active === 0) return resolve(results);
            while (active < limit && idx < items.length) {
                const i = idx++;
                active++;
                Promise.resolve(worker(items[i], i))
                    .then((val) => (results[i] = {ok: true, value: val}))
                    .catch((err) => (results[i] = {ok: false, error: err}))
                    .finally(() => {
                        active--;
                        next();
                    });
            }
        };
        next();
    });
}

(async () => {
    const rawPhones = await readPhones();
    if (rawPhones.length === 0) {
        console.error(
            `No phone numbers provided.

Examples:
  node tools/bulk-admin.mjs ${action} 619-555-1234 "(619) 555-6789" +16195550123
  node tools/bulk-admin.mjs ${action} --file phones.txt
`
        );
        process.exit(1);
    }

    // normalize & keep only valid
    const prepared = [];
    for (const p of rawPhones) {
        try {
            const e164 = normalizeToE164US(p);
            prepared.push(e164);
        } catch (e) {
            console.error(`SKIP invalid: ${p} → ${e.message}`);
        }
    }

    console.log(
        `[bulk-admin] action=${action} total=${
            prepared.length
        } concurrency=${Math.max(
            1,
            Number.isFinite(concurrency) ? concurrency : 5
        )} dryRun=${dryRun}`
    );

    if (dryRun) {
        console.log(prepared.join('\n'));
        process.exit(0);
    }

    const results = await runPool(
        prepared,
        async (phone) => {
            // simple retry with backoff
            let attempt = 0;
            const max = 3;
            let lastErr;
            while (attempt < max) {
                attempt++;
                try {
                    const res = await callEndpoint(action, phone);
                    console.log(`[OK] ${phone} → ${JSON.stringify(res)}`);
                    return res;
                } catch (e) {
                    lastErr = e;
                    console.warn(
                        `[RETRY ${attempt}/${max}] ${phone} → ${
                            e?.message || e
                        }`
                    );
                    if (attempt < max)
                        await new Promise((r) => setTimeout(r, 400 * attempt));
                }
            }
            throw lastErr;
        },
        Math.max(1, Number.isFinite(concurrency) ? concurrency : 5)
    );

    const ok = results.filter((r) => r?.ok).length;
    const fail = results.length - ok;
    console.log(`[bulk-admin] done. success=${ok} fail=${fail}`);
    if (fail > 0) process.exitCode = 1;
})();
