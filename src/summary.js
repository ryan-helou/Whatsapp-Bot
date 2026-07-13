// Optional daily summary: DMs you on Telegram once a day with what went out
// (and any failures), read from the send log. Set DAILY_SUMMARY_TIME to enable.

const cron = require('node-cron');
const { DateTime } = require('luxon');

function buildSummary(store, tz) {
  const today = DateTime.now().setZone(tz).toFormat('yyyy-LL-dd');
  const todays = store.recentLog(200).filter((e) => (e.at || '').slice(0, 10) === today);
  const sent = todays.filter((e) => e.status === 'sent');
  const failed = todays.filter((e) => e.status === 'failed');

  if (todays.length === 0) return '📭 Daily summary: nothing was scheduled to go out today.';

  const lines = [`📬 Daily summary for ${today}:`, `✓ ${sent.length} sent`];
  if (failed.length) lines.push(`✗ ${failed.length} failed`);
  for (const e of sent) lines.push(`  • ${e.group}${e.dryRun ? ' (dry run)' : ''}`);
  for (const e of failed) lines.push(`  ✗ ${e.group} — ${e.error}`);
  return lines.join('\n');
}

/**
 * Schedule the daily summary DM. No-op unless config.dailySummaryTime ("HH:MM")
 * is set and there is at least one allowed Telegram user to DM.
 */
function startDailySummary(config, store, bot) {
  const time = String(config.dailySummaryTime || '').trim();
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    if (time) console.warn(`⚠ DAILY_SUMMARY_TIME "${time}" is invalid (use HH:MM); daily summary off.`);
    return null;
  }
  const recipients = config.telegramAllowedUserIds;
  if (!bot || recipients.length === 0) {
    console.warn('⚠ Daily summary needs the Telegram bot and at least one allowed user; skipping.');
    return null;
  }

  const [, hh, mm] = m;
  const task = cron.schedule(
    `${parseInt(mm, 10)} ${parseInt(hh, 10)} * * *`,
    async () => {
      const text = buildSummary(store, config.defaultTimezone);
      for (const id of recipients) {
        try {
          await bot.api.sendMessage(id, text);
        } catch (err) {
          console.error(`Could not send daily summary to ${id}:`, err.message);
        }
      }
    },
    { timezone: config.defaultTimezone }
  );

  console.log(`✓ Daily summary scheduled for ${time} (${config.defaultTimezone}).`);
  return task;
}

module.exports = { startDailySummary, buildSummary };
