export const SITE_PASSWORD = process.env.SITE_PASSWORD || 'PASSWORD';
export const MIN_REPLY_COOLDOWN_MIN = parseInt(
    process.env.MIN_REPLY_COOLDOWN_MIN ?? '3',
    10
);
export const MAX_PER_NUMBER_PER_DAY = parseInt(
    process.env.MAX_PER_NUMBER_PER_DAY ?? '3',
    10
);
export const GLOBAL_MAX_PER_DAY = parseInt(
    process.env.GLOBAL_MAX_PER_DAY ?? '2000',
    10
);
export const REQUIRED_TEXT_KEYWORD = (
    process.env.REQUIRED_TEXT_KEYWORD || ''
).toUpperCase();
export const ALLOW_PASSWORD_REJOIN = true; // keep as you prefer

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
