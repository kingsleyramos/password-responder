// Centralized config, keys, TTLs, and compliance keywords.

function parseIntEnv(name, def) {
    const v = process.env[name];
    const n = Number.parseInt(v ?? `${def}`, 10);
    return Number.isFinite(n) ? n : def;
}

// --- product / content ---
export const SITE_PASSWORD = process.env.SITE_PASSWORD || 'PASSWORD';
export const HELP_MESSAGE =
    process.env.HELP_MESSAGE ||
    'Robyn & Kingsley Wedding Website Password Auto Reponder. Reply STOP to opt out.';

// --- behavior toggles ---
export const REQUIRED_TEXT_KEYWORD = (
    process.env.REQUIRED_TEXT_KEYWORD || ''
).toUpperCase();
// Allow PASSWORD (the required keyword) to clear local opt-out state.
// Note: If Twilio Advanced Opt-Out is ON, carriers may still require START once.
export const ALLOW_PASSWORD_REJOIN = true;

// Restrict to US E.164 (+1XXXXXXXXXX). Flip to false to allow other countries.
export const US_ONLY = true;

// --- throttles / caps ---
export const MIN_REPLY_COOLDOWN_MIN = parseIntEnv('MIN_REPLY_COOLDOWN_MIN', 3);
export const MAX_PER_NUMBER_PER_DAY = parseIntEnv('MAX_PER_NUMBER_PER_DAY', 3);
export const GLOBAL_MAX_PER_DAY = parseIntEnv('GLOBAL_MAX_PER_DAY', 2000);

// --- redis key names ---
export const KEYS = {
    WHITELIST: 'whitelist',
    ABUSE_SET: 'abuse:index', // permanent blocklist (set)
    DEFENSIVE_MODE: 'defensive:mode', // 1 when flood protection is active
    GLOBAL_DAILY_PREFIX: 'rl:global:', // rl:global:YYYY-MM-DD (light daily cap)
    PER_NUMBER_HASH_PREFIX: 'rl:num:', // rl:num:+1...
    BURST_PREFIX: 'burst:', // burst:+1...:<bucket>
    UNKNOWN_WINDOW: 'unknownFlood:window', // single rolling counter key
};

// --- TTLs (seconds) ---
export const TTL = {
    PER_NUMBER_HASH: 3 * 24 * 60 * 60, // 3 days for rl:num:+1... hash
    GLOBAL_DAILY: 2 * 24 * 60 * 60, // 2 days for rl:global:YYYY-MM-DD
};

// --- abuse thresholds ---
export const ABUSE = {
    UNKNOWN_WINDOW_MINUTES: 5, // size of global rolling window
    UNKNOWN_MESSAGE_THRESHOLD: 20, // flip defensive mode if >20 unknowns in window
    DEFENSIVE_MODE_DURATION_SEC: 3600, // defensive mode lasts 1 hour
    MAX_MESSAGES_PER_NUMBER: 5, // burst: >5 msgs in window → block
    BURST_WINDOW_SECONDS: 60, // per-number burst window in seconds
    MAX_MESSAGE_LENGTH: 160, // suspicious if >160 chars
    URL_PATTERN: /\bhttps?:\/\//i, // suspicious if contains URL
};

// --- compliance / keywords ---
export const OPT_OUTS = [
    'STOP',
    'STOPALL',
    'UNSUBSCRIBE',
    'CANCEL',
    'END',
    'QUIT',
];
export const OPT_INS = ['START', 'UNSTOP', 'YES'];
export const HELP_WORDS = ['HELP', 'INFO'];
