#!/usr/bin/env node
// Lists every group your linked account is in, with its JID (Group ID).
// Copy the JIDs you want into your Google Sheet's "Group ID" column.
// Run: npm run list-groups

const { connect } = require('../src/whatsapp');

(async () => {
  const sock = await connect();

  // Give Baileys a moment to sync group metadata after connecting.
  await new Promise((r) => setTimeout(r, 3000));

  const groups = await sock.groupFetchAllParticipating();
  const rows = Object.values(groups)
    .map((g) => ({ name: g.subject, jid: g.id, size: g.participants?.length ?? '?' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (rows.length === 0) {
    console.log('\nNo groups found. Make sure this account is a member of some groups.');
  } else {
    console.log(`\nYou are in ${rows.length} group(s):\n`);
    for (const r of rows) {
      console.log(`  • ${r.name}  (${r.size} members)`);
      console.log(`      ${r.jid}\n`);
    }
    console.log('Paste the Group IDs above into the "Group ID" column of your sheet.');
  }

  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
