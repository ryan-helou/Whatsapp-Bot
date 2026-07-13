// Central config, loaded from environment (.env). All tunables live here.

require('dotenv').config({ quiet: true });
const path = require('path');

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

const config = {
  // --- Google Sheet (the message/schedule source) ---
  googleKeyFile:
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
    path.join(__dirname, '..', 'credentials', 'service-account.json'),
  sheetId: process.env.SHEET_ID || '',
  // Sheet tab + range. Header is row 1; data starts at row 2.
  sheetRange: process.env.SHEET_RANGE || 'Schedule!A2:H',

  // --- Scheduling behavior ---
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'America/New_York',
  // How often to re-read the sheet (so edits take effect without a restart).
  pollSheetSeconds: num('POLL_SHEET_SECONDS', 300),
  // If the bot was offline at the exact send time, still send if we're within
  // this many minutes of the scheduled time. Beyond it, skip (and log) to avoid
  // firing a "9am" message at 3pm.
  catchupGraceMinutes: num('CATCHUP_GRACE_MINUTES', 120),

  // --- Anti-ban timing (kept light; volume here is tiny) ---
  // Random 0..N second delay added before each individual send.
  jitterMaxSeconds: num('JITTER_MAX_SECONDS', 90),
  // Random gap between two sends that fire in the same minute.
  sendGapMinSeconds: num('SEND_GAP_MIN_SECONDS', 15),
  sendGapMaxSeconds: num('SEND_GAP_MAX_SECONDS', 60),
  // Retry a failed send this many times before logging it as failed.
  maxRetries: num('MAX_RETRIES', 2),

  // --- Safety / testing ---
  // DRY_RUN=true logs what WOULD be sent without actually sending. Great for the
  // very first boot to confirm your sheet + schedule are correct.
  dryRun: bool('DRY_RUN', false),

  // Where the send-log / dedupe state file lives.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // --- Telegram control bot (optional) ---
  // If TELEGRAM_BOT_TOKEN is set, a Telegram bot starts so you can edit the
  // schedule by texting plain English. Needs ANTHROPIC_API_KEY too (read by the
  // Anthropic SDK directly from the environment).
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n)),
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  // Optional daily summary DM time ("HH:MM" in DEFAULT_TIMEZONE). Blank = off.
  dailySummaryTime: process.env.DAILY_SUMMARY_TIME || '',

  // Weekly rotations (e.g. attendance duty) used by {rotation:NAME} in messages.
  rotationsFile: process.env.ROTATIONS_FILE || path.join(__dirname, '..', 'config', 'rotations.json'),
};

module.exports = config;
