// Main service. Connects to WhatsApp, keeps the schedule fresh from the Google
// Sheet, and runs the minute-by-minute scheduler. This is what `npm start` runs
// and what pm2/Docker keeps alive 24/7.

const config = require('./src/config');
const { connect } = require('./src/whatsapp');
const { loadSchedule } = require('./src/sheet');
const { Store } = require('./src/store');
const { Scheduler } = require('./src/scheduler');
const { startTelegramBot } = require('./src/telegram');
const { startDailySummary } = require('./src/summary');
const groups = require('./src/groups');
const rotations = require('./src/rotations');

let currentSock = null;
let validEntries = [];

async function refreshSchedule() {
  try {
    const { valid, invalid } = await loadSchedule(config);
    validEntries = valid;
    let msg = `Schedule refreshed: ${valid.length} active row(s)`;
    if (invalid.length) msg += `, ${invalid.length} row(s) with errors (ignored)`;
    console.log(msg);
    for (const e of invalid) {
      console.warn(`  ⚠ row ${e.rowNumber} skipped: ${e.errors.join('; ')}`);
    }
  } catch (err) {
    // Keep the last good schedule if a refresh fails (e.g. transient network).
    console.error('Could not refresh schedule:', err.message);
    if (validEntries.length === 0) {
      console.error('  (no schedule loaded yet — check SHEET_ID and credentials)');
    }
  }
}

async function main() {
  console.log('WhatsApp Scheduler starting…');
  if (config.dryRun) console.log('DRY RUN mode: messages will be previewed, not sent.');

  const store = new Store(config.dataDir);
  groups.load(config.dataDir); // load cached WhatsApp group directory (if any)
  rotations.load(config.rotationsFile); // load weekly rotations (attendance, etc.)

  let groupsRefreshed = false;

  // 1. Connect to WhatsApp. onReady fires on first connect AND every reconnect,
  //    so currentSock always points at the live socket.
  await connect((sock) => {
    currentSock = sock;
    // Refresh the group directory once, shortly after the first connect.
    if (!groupsRefreshed) {
      groupsRefreshed = true;
      setTimeout(() => groups.refreshFromSock(sock), 4000);
    }
  });

  // 2. Load the schedule now, then keep it fresh on an interval.
  await refreshSchedule();
  setInterval(refreshSchedule, config.pollSheetSeconds * 1000);

  // 3. Start the heartbeat.
  const scheduler = new Scheduler({
    getSock: () => currentSock,
    store,
    config,
    getEntries: () => validEntries,
  });
  scheduler.start();

  // 4. Optional: Telegram control bot. Edits to the sheet trigger an immediate
  //    schedule refresh so changes apply without waiting for the next poll.
  if (config.telegramToken) {
    const bot = startTelegramBot(config, {
      onChanged: refreshSchedule,
      getSock: () => currentSock,
    });
    // 5. Optional daily summary DM (needs the bot + DAILY_SUMMARY_TIME).
    startDailySummary(config, store, bot);
  } else {
    console.log('Telegram control bot disabled (set TELEGRAM_BOT_TOKEN to enable).');
  }

  console.log('\n✓ Up and running. Leave this process alive (pm2/Docker on a server).');

  // Graceful shutdown.
  const shutdown = (sig) => {
    console.log(`\n${sig} received, shutting down.`);
    scheduler.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
