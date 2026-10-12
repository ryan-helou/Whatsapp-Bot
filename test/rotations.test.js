// Tests for weekly rotation resolution, including the one-off `overrides`
// mechanism added 2026-10-12 to move Julia (attendance) and Maykel (sound) a
// week later without disturbing the ongoing cycle.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');

const rotations = require('../src/rotations');

const TZ = 'America/Toronto';
const at = (iso) => DateTime.fromISO(iso, { zone: TZ });

// Write a throwaway rotations file and load it.
function withDefs(defs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rot-'));
  const file = path.join(dir, 'rotations.json');
  fs.writeFileSync(file, JSON.stringify(defs));
  rotations.load(file);
  return file;
}

// A plain 3-person weekly rotation anchored on a Monday, no opening sequence.
const basic = (extra = {}) => [
  {
    name: 'test',
    anchor: '2026-10-05',
    timezone: TZ,
    members: ['A', 'B', 'C'],
    ...extra,
  },
];

test('without overrides it is a plain modular rotation', () => {
  withDefs(basic());
  assert.strictEqual(rotations.currentMember('test', at('2026-10-05')), 'A');
  assert.strictEqual(rotations.currentMember('test', at('2026-10-12')), 'B');
  assert.strictEqual(rotations.currentMember('test', at('2026-10-19')), 'C');
  assert.strictEqual(rotations.currentMember('test', at('2026-10-26')), 'A');
});

test('an override replaces just that week', () => {
  withDefs(basic({ overrides: { '2026-10-12': { lead: 'Zed' } } }));
  assert.strictEqual(rotations.currentMember('test', at('2026-10-05')), 'A', 'week before untouched');
  assert.strictEqual(rotations.currentMember('test', at('2026-10-12')), 'Zed', 'overridden');
  assert.strictEqual(rotations.currentMember('test', at('2026-10-19')), 'C', 'week after untouched');
  assert.strictEqual(rotations.currentMember('test', at('2026-10-26')), 'A', 'cycle continues');
});

test('any day inside the target week matches the override', () => {
  withDefs(basic({ overrides: { '2026-10-12': { lead: 'Zed' } } }));
  // Mon through Sun of that rotation week.
  for (const d of ['2026-10-12', '2026-10-14', '2026-10-17', '2026-10-18']) {
    assert.strictEqual(rotations.currentMember('test', at(d)), 'Zed', `${d} is in the overridden week`);
  }
  // And the key itself need not be the Monday.
  withDefs(basic({ overrides: { '2026-10-17': 'Sat' } }));
  assert.strictEqual(
    rotations.currentMember('test', at('2026-10-12')),
    'Sat',
    'a Saturday key still overrides its whole week'
  );
});

test('an override may be a bare name or carry a shadow', () => {
  withDefs(basic({ overrides: { '2026-10-12': 'Solo' } }));
  assert.strictEqual(rotations.currentMember('test', at('2026-10-12')), 'Solo');

  withDefs(basic({ overrides: { '2026-10-12': { lead: 'Lead', shadow: 'Learner' } } }));
  assert.strictEqual(
    rotations.currentMember('test', at('2026-10-12')),
    'Lead (with Learner shadowing)'
  );
});

test('overrides win over an opening sequence', () => {
  withDefs(
    basic({
      sequence: [{ lead: 'Seq0' }, { lead: 'Seq1' }],
      overrides: { '2026-10-12': { lead: 'Over' } },
    })
  );
  assert.strictEqual(rotations.currentMember('test', at('2026-10-05')), 'Seq0', 'sequence still applies');
  assert.strictEqual(rotations.currentMember('test', at('2026-10-12')), 'Over', 'override beats sequence');
});

test('an unparseable override date is ignored, not fatal', () => {
  withDefs(basic({ overrides: { 'next tuesday': { lead: 'Nope' } } }));
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(
      rotations.currentMember('test', at('2026-10-12')),
      'B',
      'falls back to the normal rotation'
    );
  } finally {
    console.error = realErr;
  }
});

// ---------------------------------------------------------------------------
// The production config — locks in the swap Ryan asked for on 2026-10-12.
// ---------------------------------------------------------------------------
test('production config: Julia and Maykel are moved to the week of Oct 19', () => {
  rotations.load(path.join(__dirname, '..', 'config', 'rotations.json'));

  // This week: the people who were on Oct 19 cover instead.
  assert.strictEqual(rotations.currentMember('attendance', at('2026-10-12')), 'Ryan');
  assert.strictEqual(rotations.currentMember('sound', at('2026-10-12')), 'Manweel');

  // Next week: the two who were moved.
  assert.strictEqual(rotations.currentMember('attendance', at('2026-10-19')), 'Julia');
  assert.strictEqual(rotations.currentMember('sound', at('2026-10-19')), 'Maykel');

  // Saturday of this week resolves the same as its Monday — the day-of reminder
  // must agree with the Monday announcement.
  assert.strictEqual(rotations.currentMember('attendance', at('2026-10-17')), 'Ryan');
  assert.strictEqual(rotations.currentMember('sound', at('2026-10-17')), 'Manweel');

  // And the steady cycle resumes untouched afterwards.
  assert.strictEqual(rotations.currentMember('attendance', at('2026-10-26')), 'Jona');
  assert.strictEqual(rotations.currentMember('sound', at('2026-10-26')), 'Ryan');
  assert.strictEqual(rotations.currentMember('attendance', at('2026-11-02')), 'Aly');
  assert.strictEqual(rotations.currentMember('sound', at('2026-11-02')), 'Anthony');
});

test('production config: nobody is scheduled two weeks running', () => {
  rotations.load(path.join(__dirname, '..', 'config', 'rotations.json'));
  for (const name of ['attendance', 'sound']) {
    let prev = null;
    for (let w = 0; w < 10; w++) {
      const who = rotations.currentMember(name, at('2026-10-12').plus({ weeks: w }));
      assert.notStrictEqual(who, prev, `${name}: ${who} is on back-to-back weeks from week ${w - 1}`);
      prev = who;
    }
  }
});
