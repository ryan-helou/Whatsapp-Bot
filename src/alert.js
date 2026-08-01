// Outbound-only Telegram alerting.
//
// Deliberately NOT a grammy bot. Telegram allows exactly ONE long-polling
// consumer per bot token, and this reuses the Secretary bot's token — polling
// here would steal Secretary's updates and break it. We only ever POST to
// sendMessage, which has no such restriction.
//
// Everything here is best-effort: an alert must never throw into a caller and
// never block the scheduler. If Telegram is down, we log and move on.

const fs = require('fs');
const path = require('path');

const TOKEN = (process.env.ALERT_TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.ALERT_TELEGRAM_CHAT_ID || '').trim();

const numEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Don't re-send the same alert more often than this — a flapping connection
// must not turn into a hundred notifications.
const REPEAT_MS = numEnv('ALERT_REPEAT_MINUTES', 30) * 60 * 1000;

const SEND_TIMEOUT_MS = 10000;

// Survives restarts (DATA_DIR is on the persistent volume), so a process that
// exits to recover can still tell you it came back.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const OUTAGE_FLAG = path.join(DATA_DIR, 'outage.flag');

const lastSent = new Map();

const enabled = () => !!(TOKEN && CHAT_ID);

/**
 * Send an alert. Never throws.
 * @param {string} key throttling key — repeats within ALERT_REPEAT_MINUTES are dropped
 * @param {string} text message body
 * @param {object} [opts]
 * @param {boolean} [opts.force] bypass throttling (for one-shot, high-signal events)
 * @returns {Promise<boolean>} whether a message was actually delivered
 */
async function alert(key, text, { force = false } = {}) {
  if (!enabled()) return false;

  const now = Date.now();
  if (!force) {
    const prev = lastSent.get(key);
    if (prev && now - prev < REPEAT_MS) return false;
  }
  lastSent.set(key, now);

  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`  ⚠ alert "${key}" not delivered: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`  ⚠ alert "${key}" not delivered: ${err.message}`);
    return false;
  }
}

// --- outage flag -----------------------------------------------------------
// Set when we tell Ryan something is wrong; cleared when we tell him it's back.
// Because it lives on disk, the "recovered" message still fires even when the
// recovery happened via a process exit + host restart (a fresh process has no
// memory of the outage).

function markOutage(reason) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OUTAGE_FLAG, JSON.stringify({ at: new Date().toISOString(), reason }));
  } catch (_) {
    /* best effort */
  }
}

function outageInfo() {
  try {
    return JSON.parse(fs.readFileSync(OUTAGE_FLAG, 'utf8'));
  } catch (_) {
    return null;
  }
}

function clearOutage() {
  try {
    fs.rmSync(OUTAGE_FLAG, { force: true });
  } catch (_) {
    /* best effort */
  }
}

module.exports = { alert, enabled, markOutage, outageInfo, clearOutage };
