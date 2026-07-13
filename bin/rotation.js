#!/usr/bin/env node
// Preview weekly rotations: who's up this week and the next several weeks.
// Run: npm run rotation           (all rotations)
//      npm run rotation attendance (one rotation)

const config = require('../src/config');
const rotations = require('../src/rotations');
const { currentMember } = rotations;
const { DateTime } = require('luxon');

rotations.load(config.rotationsFile);

const filter = (process.argv[2] || '').toLowerCase();
const all = rotations.list().filter((r) => !filter || r.name.toLowerCase() === filter);

if (all.length === 0) {
  console.log(filter ? `No rotation named "${filter}".` : `No rotations defined in ${config.rotationsFile}.`);
  process.exit(0);
}

for (const r of all) {
  const tz = r.timezone || config.defaultTimezone;
  const now = DateTime.now().setZone(tz);
  console.log(`\nRotation "${r.name}"  (${r.members.join(' → ')}), anchor ${r.anchor}, ${tz}`);
  for (let w = 0; w < 6; w++) {
    const when = now.plus({ weeks: w });
    const who = currentMember(r.name, when);
    const label = w === 0 ? 'this week' : `+${w}wk`;
    console.log(`  ${label.padEnd(9)} ${when.toFormat('yyyy-LL-dd')}  → ${who}`);
  }
}
console.log('');
