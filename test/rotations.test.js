// Tests for weekly rotation resolution, including the one-off `overrides`
// mechanism added 2026-10-12 to move Erin (attendance) and Noor (sound) a
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
// The shipped example config — this is what someone who clones the repo gets,
// so it has to actually work.
// ---------------------------------------------------------------------------
test('example config: the rotation cycles and the sample override lands', () => {
  rotations.load(path.join(__dirname, '..', 'config', 'rotations.example.json'));

  // anchor is 2026-01-05, a Monday, and week 0 is the first member.
  assert.strictEqual(rotations.currentMember('attendance', at('2026-01-05')), 'Alex');
  assert.strictEqual(rotations.currentMember('attendance', at('2026-01-12')), 'Blake');
  // ...and it wraps after the last member.
  assert.strictEqual(rotations.currentMember('attendance', at('2026-02-09')), 'Alex');

  // The documented example overrides swap two weeks: Drew and Erin trade.
  assert.strictEqual(rotations.currentMember('attendance', at('2026-02-23')), 'Casey', 'week before the swap');
  assert.strictEqual(rotations.currentMember('attendance', at('2026-03-02')), 'Erin', 'would be Drew');
  assert.strictEqual(rotations.currentMember('attendance', at('2026-03-09')), 'Drew', 'would be Erin');
  assert.strictEqual(rotations.currentMember('attendance', at('2026-03-16')), 'Alex', 'normal cycle resumes');

  // The sound rotation opens with a shadowing phase, then falls back to members.
  assert.strictEqual(rotations.currentMember('sound', at('2026-01-05')), 'Alex (with Noor shadowing)');
  assert.strictEqual(rotations.currentMember('sound', at('2026-02-02')), 'Alex', 'sequence used up, plain cycle resumes');
});

test('example config: nobody is scheduled two weeks running', () => {
  rotations.load(path.join(__dirname, '..', 'config', 'rotations.example.json'));
  for (const name of ['attendance', 'sound']) {
    let prev = null;
    for (let w = 0; w < 12; w++) {
      const who = rotations.currentMember(name, at('2026-01-05').plus({ weeks: w }));
      assert.notStrictEqual(who, prev, `${name}: ${who} lands on back-to-back weeks at week ${w}`);
      prev = who;
    }
  }
});

// A real config/rotations.json is deliberately untracked (it names actual
// people), so a fresh clone skips this. It still guards the live file locally.
test('local rotations.json, when present, is valid and never doubles up', (t) => {
  const file = path.join(__dirname, '..', 'config', 'rotations.json');
  if (!fs.existsSync(file)) {
    t.skip('no local config/rotations.json — nothing to check');
    return;
  }
  rotations.load(file);
  const defs = rotations.list();
  assert.ok(defs.length > 0, 'a local config should define at least one rotation');
  for (const def of defs) {
    let prev = null;
    for (let w = 0; w < 12; w++) {
      const who = rotations.currentMember(def.name, at('2026-01-05').plus({ weeks: w }));
      assert.ok(who, `${def.name} should resolve someone for every week`);
      assert.notStrictEqual(who, prev, `${def.name}: ${who} lands on back-to-back weeks`);
      prev = who;
    }
  }
});
