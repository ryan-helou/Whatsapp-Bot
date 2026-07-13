#!/usr/bin/env node
// Validates your Google Sheet WITHOUT connecting to WhatsApp. Prints each row,
// any errors, and the next time it will send. Run this after editing the sheet.
// Run: npm run check-sheet

const config = require('../src/config');
const { loadSchedule } = require('../src/sheet');
const { nextRun } = require('../src/schedule');
const rotations = require('../src/rotations');
const { render } = require('../src/template');
const { DateTime } = require('luxon');

(async () => {
  rotations.load(config.rotationsFile);
  console.log(`Reading sheet ${config.sheetId || '(SHEET_ID not set!)'}\n`);
  const { valid, invalid } = await loadSchedule(config);
  const now = DateTime.now();

  if (valid.length) {
    console.log(`✓ ${valid.length} active row(s):\n`);
    for (const e of valid) {
      const next = nextRun(e, now);
      const when = next ? next.toFormat("ccc yyyy-LL-dd HH:mm '('ZZZZ')'") : 'never';
      // Render placeholders as they'd appear at the next send time.
      const rendered = render(e.message, (next || now).setZone(e.timezone)).text;
      const what = e.mediaUrl ? `[media] ${rendered}` : rendered;
      console.log(`  Row ${e.rowNumber}: ${e.groupName}`);
      console.log(`    "${what}"`);
      console.log(`    next send: ${when}\n`);
    }
  } else {
    console.log('No valid rows found.\n');
  }

  if (invalid.length) {
    console.log(`⚠ ${invalid.length} row(s) with problems (these are ignored):\n`);
    for (const e of invalid) {
      console.log(`  Row ${e.rowNumber} (${e.groupName}): ${e.errors.join('; ')}`);
    }
    console.log('');
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed to read sheet:', err.message);
  process.exit(1);
});
