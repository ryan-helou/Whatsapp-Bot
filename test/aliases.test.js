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
  withAliases({ aliases: { 'tracy 💅': 'Tracy' } });
  assert.strictEqual(aliases.apply('tracy 💅'), 'Tracy');
  assert.strictEqual(aliases.apply('@⁨tracy 💅⁩ is leading'), '@⁨Tracy⁩ is leading');
  assert.strictEqual(aliases.apply('tracy 💅 created this group'), 'Tracy created this group');
});

test('leaves everything else alone', () => {
  withAliases({ aliases: { 'tracy 💅': 'Tracy' } });
  // The bare word, without the emoji, is ordinary prose and must not be touched.
  assert.strictEqual(aliases.apply('ask tracy about it'), 'ask tracy about it');
  assert.strictEqual(aliases.apply(''), '');
  assert.strictEqual(aliases.apply(undefined), undefined);
});

test('longest match wins, so one name inside another is safe', () => {
  withAliases({ aliases: { 'jules': 'WRONG', 'jules🧸': 'Julia' } });
  assert.strictEqual(aliases.apply('jules🧸'), 'Julia', 'the longer key must be applied first');
});

test('comment keys are ignored and a missing file is harmless', () => {
  withAliases({ _comment: 'notes', aliases: { 'a': 'b' } });
  assert.strictEqual(aliases.count(), 1, 'the _comment key is not an alias');

  aliases.load('/nonexistent/aliases.json');
  assert.strictEqual(aliases.count(), 0);
  assert.strictEqual(aliases.apply('tracy 💅'), 'tracy 💅', 'no aliases means no change');
});

test('a bare map (no "aliases" wrapper) also works', () => {
  withAliases({ 'bro🤗': 'James' });
  assert.strictEqual(aliases.apply('bro🤗'), 'James');
});

test('end to end: the sender AND the mention are renamed together', () => {
  withAliases({
    aliases: { 'tracy 💅': 'Tracy', 'chlo money💸': 'Chloe', 'bro🤗': 'James', 'jules🧸': 'Julia' },
  });
  const raw = [
    `[2026-06-01, 1:00:00${NB}PM] tracy 💅: Leader: @⁨chlo money💸⁩ and @⁨bro🤗⁩`,
    `[2026-06-01, 1:05:00${NB}PM] jules🧸: on it`,
    `[2022-09-20, 11:57:26${NB}AM] tracy 💅: ${LRM}tracy 💅 created this group`,
  ].join('\n');
  const es = parseExport(raw, 'English ministry (music)');

  assert.strictEqual(es[0].sender, 'Tracy');
  assert.strictEqual(es[0].text, 'Leader: @⁨Chloe⁩ and @⁨James⁩', 'mentions renamed too');
  assert.strictEqual(es[1].sender, 'Julia');
  assert.strictEqual(es[2].system, true);
  assert.strictEqual(es[2].text, 'Tracy created this group', 'system text renamed');
});
