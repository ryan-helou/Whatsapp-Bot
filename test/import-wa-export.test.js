// Tests for parsing WhatsApp's own "Export chat" output.
//
// The format carries three quirks that silently corrupt a naive parser, so each
// gets a test: a NARROW NO-BREAK SPACE before AM/PM, a LEFT-TO-RIGHT MARK that
// is the ONLY signal separating a system event from someone saying the same
// words, and `<attached: file>` which may appear on the first line of a message
// or on a later line after a caption.

const { test } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const { parseExport, toMessage, kindFromFile } = require('../bin/import-wa-export.js');

const TZ = 'America/Toronto';
const NB = ' '; // narrow no-break space, what WhatsApp actually emits
const LRM = '‎';
const CHAT = 'English ministry (music)';

const at = (e) =>
  DateTime.fromFormat(`${e.date} ${e.time} ${e.meridiem}`, 'yyyy-MM-dd h:mm:ss a', { zone: TZ });

test('parses the real line shape, narrow no-break space and all', () => {
  const [e] = parseExport(`[2026-11-16, 7:26:11${NB}PM] Joanne Awad: Hey everyone quick question`, CHAT);
  assert.strictEqual(e.sender, 'Joanne Awad');
  assert.strictEqual(e.text, 'Hey everyone quick question');
  assert.strictEqual(e.system, false);
  assert.strictEqual(at(e).toFormat('yyyy-LL-dd HH:mm'), '2026-11-16 19:26');
});

test('converts 12-hour times correctly at both noon and midnight', () => {
  const es = parseExport(
    [`[2026-01-02, 12:00:00${NB}AM] A: midnight`, `[2026-01-02, 12:30:00${NB}PM] A: noon`].join('\n'),
    CHAT
  );
  assert.strictEqual(at(es[0]).toFormat('HH:mm'), '00:00', '12 AM is 00:xx, not 12:xx');
  assert.strictEqual(at(es[1]).toFormat('HH:mm'), '12:30', '12 PM stays 12:xx');
});

test('a multi-line message stays one message', () => {
  const raw = [
    `[2026-11-16, 9:26:00${NB}PM] Joe Awad: Hey guys, here are the songs.`,
    '',
    'As the deer - A',
    'Agnus Dei',
    '',
    `Let's have a practice at 6:30`,
  ].join('\n');
  const es = parseExport(raw, CHAT);
  assert.strictEqual(es.length, 1, 'continuation lines must not become new messages');
  assert.match(es[0].text, /^Hey guys, here are the songs\./);
  assert.match(es[0].text, /As the deer - A\nAgnus Dei/);
  assert.match(es[0].text, /practice at 6:30$/);
});

test('attachments are found on the first line or after a caption', () => {
  const first = parseExport(
    `${LRM}[2024-09-28, 9:40:18${NB}PM] tracy: ${LRM}<attached: 00000012-PHOTO-2024-09-28-21-40-18.jpg>`,
    CHAT
  )[0];
  assert.deepStrictEqual(first.attachments, ['00000012-PHOTO-2024-09-28-21-40-18.jpg']);
  assert.strictEqual(first.text, '', 'the marker itself is not message text');
  assert.strictEqual(first.system, false, 'an attachment is not a system event');

  const captioned = parseExport(
    [`[2024-10-18, 11:49:52${NB}PM] Josée: Here are the songs for Sunday!`,
     `${LRM}<attached: 00000027-PHOTO-2024-10-18-23-49-52.jpg>`].join('\n'),
    CHAT
  )[0];
  assert.deepStrictEqual(captioned.attachments, ['00000027-PHOTO-2024-10-18-23-49-52.jpg']);
  assert.strictEqual(captioned.text, 'Here are the songs for Sunday!', 'caption survives');
});

test('the LRM is what distinguishes a system event from someone saying it', () => {
  const sys = parseExport(`[2022-09-20, 11:57:26${NB}AM] tracy: ${LRM}tracy created this group`, CHAT)[0];
  assert.strictEqual(sys.system, true);
  assert.strictEqual(sys.sender, null, 'a system event has no speaker');

  // Same words, no LRM — a person actually typed this.
  const said = parseExport(`[2022-09-20, 11:57:26${NB}AM] tracy: tracy created this group`, CHAT)[0];
  assert.strictEqual(said.system, false);
  assert.strictEqual(said.sender, 'tracy');
});

test('messages attributed to the group itself are system messages', () => {
  const e = parseExport(`[2024-09-23, 1:37:55${NB}PM] ${CHAT}: ${LRM}tracy added you`, CHAT)[0];
  assert.strictEqual(e.system, true);
  assert.strictEqual(e.sender, null);
});

test('a ~ prefix (not in contacts) is stripped from the name', () => {
  const e = parseExport(`[2026-06-01, 1:00:00${NB}PM] ~${NB}Judy Mezaber: hi`, CHAT)[0];
  assert.strictEqual(e.sender, 'Judy Mezaber');
});

test('only the FIRST colon splits sender from text', () => {
  const e = parseExport(`[2026-06-01, 1:00:00${NB}PM] Brad: Songs: Abide, He Is Exalted`, CHAT)[0];
  assert.strictEqual(e.sender, 'Brad');
  assert.strictEqual(e.text, 'Songs: Abide, He Is Exalted');
});

test('preamble before the first timestamp is ignored', () => {
  const es = parseExport(`some junk header\n[2026-06-01, 1:00:00${NB}PM] Brad: real`, CHAT);
  assert.strictEqual(es.length, 1);
  assert.strictEqual(es[0].text, 'real');
});

test('attachment kinds are inferred from the filename', () => {
  assert.strictEqual(kindFromFile('00000012-PHOTO-2024-09-28.jpg'), 'image');
  assert.strictEqual(kindFromFile('00000012-VIDEO-2024-09-28.mp4'), 'video');
  assert.strictEqual(kindFromFile('00000012-AUDIO-2024-09-28.opus'), 'audio');
  assert.strictEqual(kindFromFile('setlist.pdf'), 'document');
});

test('a parsed entry becomes a renderable message with the right timestamp', () => {
  const e = parseExport(`[2026-11-16, 7:26:11${NB}PM] Joanne Awad: hello`, CHAT)[0];
  const m = toMessage(e, 0, TZ);
  assert.strictEqual(m.pushName, 'Joanne Awad');
  assert.strictEqual(m.message.conversation, 'hello');
  assert.strictEqual(
    DateTime.fromSeconds(m.messageTimestamp, { zone: TZ }).toFormat('yyyy-LL-dd HH:mm'),
    '2026-11-16 19:26'
  );
});
