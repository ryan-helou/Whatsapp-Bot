#!/usr/bin/env node
// Prints the most recent send attempts (ok/failed). Run: npm run log

const config = require('../src/config');
const { Store } = require('../src/store');

const store = new Store(config.dataDir);
const entries = store.recentLog(30);

if (entries.length === 0) {
  console.log('No sends logged yet.');
} else {
  console.log(`Last ${entries.length} send(s):\n`);
  for (const e of entries) {
    const mark = e.status === 'sent' ? '✓' : '✗';
    const extra = e.status === 'failed' ? `  — ${e.error}` : e.dryRun ? '  (dry run)' : '';
    console.log(`  ${mark} ${e.at}  row ${e.row}  ${e.group}${extra}`);
  }
}
