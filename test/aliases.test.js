// Display-name aliasing. The point is that a renamed speaker and an unrenamed
// @mention of that same person read as two different people, so replacement has
// to reach message text too — not just the sender field.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const aliases = require('../src/aliases');
const { parseExport } = require('../bin/import-wa-export.js');

const NB = ' ';
const LRM = '‎';

function withAliases(map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-alias-'));
  const file = path.join(dir, 'a.json');
  fs.writeFileSync(file, JSON.stringify(map));
  aliases.load(file);
  return file;
}

test('renames a name wherever it appears', () => {
  withAliases({ aliases: { 'bee🐝': 'Bee' } });
  assert.strictEqual(aliases.apply('bee🐝'), 'Bee');
  assert.strictEqual(aliases.apply('@⁨bee🐝⁩ is leading'), '@⁨Bee⁩ is leading');
  assert.strictEqual(aliases.apply('bee🐝 created this group'), 'Bee created this group');
});

test('leaves everything else alone', () => {
  withAliases({ aliases: { 'bee🐝': 'Bee' } });
  // The bare word, without the emoji, is ordinary prose and must not be touched.
  assert.strictEqual(aliases.apply('ask bee about it'), 'ask bee about it');
  assert.strictEqual(aliases.apply(''), '');
  assert.strictEqual(aliases.apply(undefined), undefined);
});

test('longest match wins, so one name inside another is safe', () => {
  withAliases({ aliases: { 'cat': 'WRONG', 'cat🐱': 'Erin' } });
  assert.strictEqual(aliases.apply('cat🐱'), 'Erin', 'the longer key must be applied first');
});

test('comment keys are ignored and a missing file is harmless', () => {
  withAliases({ _comment: 'notes', aliases: { 'a': 'b' } });
  assert.strictEqual(aliases.count(), 1, 'the _comment key is not an alias');

  aliases.load('/nonexistent/aliases.json');
  assert.strictEqual(aliases.count(), 0);
  assert.strictEqual(aliases.apply('bee🐝'), 'bee🐝', 'no aliases means no change');
});

test('a bare map (no "aliases" wrapper) also works', () => {
  withAliases({ 'dee😎': 'Dee' });
  assert.strictEqual(aliases.apply('dee😎'), 'Dee');
});

test('end to end: the sender AND the mention are renamed together', () => {
  withAliases({
    aliases: { 'bee🐝': 'Bee', 'alex the great🔥': 'Alex', 'dee😎': 'Dee', 'cat🐱': 'Erin' },
  });
  const raw = [
    `[2026-06-01, 1:00:00${NB}PM] bee🐝: Leader: @⁨alex the great🔥⁩ and @⁨dee😎⁩`,
    `[2026-06-01, 1:05:00${NB}PM] cat🐱: on it`,
    `[2022-09-20, 11:57:26${NB}AM] bee🐝: ${LRM}bee🐝 created this group`,
  ].join('\n');
  const es = parseExport(raw, 'English ministry (music)');

  assert.strictEqual(es[0].sender, 'Bee');
  assert.strictEqual(es[0].text, 'Leader: @⁨Alex⁩ and @⁨Dee⁩', 'mentions renamed too');
  assert.strictEqual(es[1].sender, 'Erin');
  assert.strictEqual(es[2].system, true);
  assert.strictEqual(es[2].text, 'Bee created this group', 'system text renamed');
});
