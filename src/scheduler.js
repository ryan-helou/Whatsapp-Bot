// The heartbeat: every minute, find entries that are due and send them,
// spacing sends out with light randomized timing (anti-ban) and deduping so
// nothing sends twice on the same day.

const cron = require('node-cron');
const { DateTime } = require('luxon');
const { isDue, dedupeKey } = require('./schedule');
const { sendEntry, sleep } = require('./sender');
const { renderEntry } = require('./template');

const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

class Scheduler {
  /**
   * @param {object} deps
   * @param {() => object|null} deps.getSock returns the CURRENT Baileys socket
   *        (looked up each tick so reconnects don't leave us on a stale socket)
   * @param {Store}  deps.store    dedupe + log
   * @param {object} deps.config
   * @param {() => Array} deps.getEntries returns the current valid entries
   */
  constructor({ getSock, store, config, getEntries }) {
    this.getSock = getSock;
    this.store = store;
    this.config = config;
    this.getEntries = getEntries;
    this.task = null;
    this.running = false;
  }

  start() {
    // Clear any reservations left "sending" by a previous crash so they can
    // be re-evaluated (may retry within the grace window).
    this.store.clearStaleSending();
    // Fire every minute, on the minute.
    this.task = cron.schedule('* * * * *', () => this.tick());
    console.log('✓ Scheduler running (checks every minute).');
  }

  stop() {
    if (this.task) this.task.stop();
  }

  async tick() {
    // Never overlap ticks (a long jittered batch could exceed 60s).
    if (this.running) return;
    this.running = true;
    try {
      const sock = this.getSock();
      if (!sock) return; // not connected right now; try again next minute

      const now = DateTime.now();
      const grace = this.config.catchupGraceMinutes;

      // Collect due entries and reserve them synchronously so a later tick
      // can't double-fire the same row.
      const batch = [];
      for (const entry of this.getEntries()) {
        const { due } = isDue(entry, now, grace);
        if (!due) continue;
        const key = dedupeKey(entry, now);
        if (this.store.reserve(key)) batch.push({ entry, key });
      }
      if (batch.length === 0) return;

      console.log(`\n[${now.toISO()}] ${batch.length} message(s) due.`);

      for (let i = 0; i < batch.length; i++) {
        const { entry, key } = batch[i];

        // Per-send jitter so timing isn't robotic.
        const jitterMs = randInt(0, this.config.jitterMaxSeconds) * 1000;
        if (jitterMs) await sleep(jitterMs);

        // Render any dynamic placeholders ({rotation:x}, {next_saturday}, …).
        const toSend = renderEntry(entry, now);
        const result = await sendEntry(sock, toSend, this.config);
        if (result.ok) {
          console.log(`  ✓ sent to ${entry.groupName} (row ${entry.rowNumber})`);
          this.store.markSent(key, {
            row: entry.rowNumber,
            group: entry.groupName,
            jid: entry.jid,
            dryRun: !!result.dryRun,
          });
        } else {
          console.error(`  ✗ giving up on ${entry.groupName} (row ${entry.rowNumber})`);
          this.store.markFailed(key, {
            row: entry.rowNumber,
            group: entry.groupName,
            jid: entry.jid,
            error: result.error,
          });
        }

        // Gap before the next send in this batch.
        if (i < batch.length - 1) {
          const gap = randInt(this.config.sendGapMinSeconds, this.config.sendGapMaxSeconds);
          await sleep(gap * 1000);
        }
      }
    } catch (err) {
      console.error('Scheduler tick error:', err.message);
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Scheduler };
