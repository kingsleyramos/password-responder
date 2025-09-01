export function dayKey(date = new Date()) {
    // local-day boundary
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 10);
}

export async function parseFormBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () =>
            resolve(Object.fromEntries(new URLSearchParams(data)))
        );
    });
}

// Strict E.164 (+1XXXXXXXXXX) validator
export function assertE164US(input) {
    const v = String(input || '').trim();
    if (!/^\+1\d{10}$/.test(v)) {
        throw new Error(
            `Invalid format: "${input}". Expected E.164 US format: +1XXXXXXXXXX`
        );
    }
    return v;
}

// Normalize common US formats to E.164 +1XXXXXXXXXX
export function normalizeToE164US(input) {
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

export function parseIntEnv(name, def) {
    const v = process.env[name];
    const n = Number.parseInt(v ?? `${def}`, 10);
    return Number.isFinite(n) ? n : def;
}
