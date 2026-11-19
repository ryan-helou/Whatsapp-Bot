// Tests for the chat-export renderer: the format Ryan and an AI both have to
// read. Pure functions only — no WhatsApp socket, no network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');

const { describe: describeMsg, quotedTextOf, render, Store } = require('../bin/export-chat.js');

const TZ = 'America/Toronto';
const ts = (iso) => Math.floor(DateTime.fromISO(iso, { zone: TZ }).toSeconds());

const tmpStore = () =>
  new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-exp-')), 'raw.jsonl'));

const msg = ({ id, from, name, at, text, fromMe = false, extra }) => ({
  key: { id, remoteJid: 'g@g.us', participant: from, fromMe },
  pushName: name,
  messageTimestamp: at,
  message: extra || { conversation: text },
});

test('extracts text from the message shapes WhatsApp actually sends', () => {
  assert.deepStrictEqual(describeMsg({ message: { conversation: 'hi' } }), { text: 'hi', kind: 'text' });
  assert.deepStrictEqual(
    describeMsg({ message: { extendedTextMessage: { text: 'reply' } } }),
    { text: 'reply', kind: 'text' }
  );
  assert.deepStrictEqual(
    describeMsg({ message: { imageMessage: { caption: 'the chords' } } }),
    { text: 'the chords', kind: 'image' }
  );
  assert.strictEqual(describeMsg({ message: { audioMessage: { ptt: true, seconds: 12 } } }).kind, 'voice note');
  assert.strictEqual(describeMsg({ message: { protocolMessage: { type: 0 } } }).kind, 'deleted');
  // Key-distribution plumbing is not a message and must not appear in the log.
  assert.strictEqual(describeMsg({ message: { senderKeyDistributionMessage: {} } }), null);
});

test('a poll lists its options, and a reply quotes what it answered', () => {
  const poll = describeMsg({
    message: { pollCreationMessage: { name: 'Practice time?', options: [{ optionName: '6:30' }, { optionName: '7:00' }] } },
  });
  assert.strictEqual(poll.kind, 'poll');
  assert.match(poll.text, /Practice time\?.*6:30 \/ 7:00/);

  const quoted = quotedTextOf({
    message: { extendedTextMessage: { text: 'yes', contextInfo: { quotedMessage: { conversation: 'Can you make 6:30?' } } } },
  });
  assert.strictEqual(quoted, 'Can you make 6:30?');
});

test('renders days, times, senders and multi-line messages readably', () => {
  const store = tmpStore();
  store.add(msg({ id: '1', from: '1@s.whatsapp.net', name: 'Robin Lee', at: ts('2026-11-16T19:26:00'),
    text: 'Hey everyone quick question, anyone know where are the plugs for our keyboard' }));
  store.add(msg({ id: '2', from: '2@s.whatsapp.net', name: 'Sam Diaz', at: ts('2026-11-16T21:26:00'),
    text: 'Hey guys, here are the songs for this Saturday.\n\nAs the deer - A\nAgnus Dei\n\nLet\'s have a practice at 6:30' }));
  store.add(msg({ id: '3', from: null, name: null, fromMe: true, at: ts('2026-11-18T21:35:00'),
    text: 'Hey everyone, here are the songs for this Sunday:\n\nAbide\nIn Christ Alone' }));

  const out = render(store, {
    chatName: 'English ministry (music)', months: 6,
    cutoffTs: ts('2026-05-19T00:00:00'), selfName: 'Ryan',
  });

  // Day headings, in order.
  assert.ok(out.includes('---- 2026-11-16 (Monday) ----'), 'Monday heading');
  assert.ok(out.includes('---- 2026-11-18 (Wednesday) ----'), 'Wednesday heading');
  assert.ok(out.indexOf('---- 2026-11-16') < out.indexOf('---- 2026-11-18'), 'days in chronological order');

  // One message per line, "HH:MM  Sender: text".
  assert.match(out, /^19:26 {2}Robin Lee: Hey everyone quick question/m);
  assert.match(out, /^21:26 {2}Sam Diaz: Hey guys, here are the songs for this Saturday\./m);

  // Continuation lines indented by exactly 4 spaces, so they can't be mistaken
  // for new messages by either a human or a parser.
  assert.match(out, /^ {4}As the deer - A$/m);
  assert.match(out, /^ {4}Agnus Dei$/m);

  // fromMe is attributed to the account owner, not a phone number.
  assert.match(out, /^21:35 {2}Ryan: Hey everyone, here are the songs for this Sunday:/m);

  // Header metadata a reader needs to trust the file.
  assert.match(out, /^ENGLISH MINISTRY \(MUSIC\) — MESSAGE LOG$/m);
  assert.match(out, /^Messages: +3$/m);
  assert.match(out, /^Actually covers: +2026-11-16 to 2026-11-18$/m);
  assert.match(out, /^ +1 {2}Sam Diaz$/m);
});

test('messages older than the window are excluded', () => {
  const store = tmpStore();
  store.add(msg({ id: 'old', from: '1@s.whatsapp.net', name: 'Old', at: ts('2026-01-01T10:00:00'), text: 'ancient' }));
  store.add(msg({ id: 'new', from: '1@s.whatsapp.net', name: 'New', at: ts('2026-11-18T10:00:00'), text: 'recent' }));
  const out = render(store, {
    chatName: 'g', months: 6, cutoffTs: ts('2026-05-19T00:00:00'), selfName: 'Ryan',
  });
  assert.ok(!out.includes('ancient'), 'outside the window is dropped');
  assert.ok(out.includes('recent'));
  assert.match(out, /^Messages: +1$/m);
});

test('an incomplete pull says so in the file itself', () => {
  const store = tmpStore();
  store.add(msg({ id: '1', from: '1@s.whatsapp.net', name: 'A', at: ts('2026-11-18T10:00:00'), text: 'hi' }));
  const out = render(store, {
    chatName: 'g', months: 6, cutoffTs: ts('2026-05-19T00:00:00'), selfName: 'Ryan',
    coverageWarning: 'WhatsApp stopped serving older messages at 2026-09-02.',
  });
  // The gap must be visible to whoever reads the file later, not just in a
  // terminal that scrolled away, and it must be impossible to skim past.
  assert.match(out, /^INCOMPLETE — READ THIS$/m);
  assert.match(out, /WhatsApp stopped serving older messages at 2026-09-02/);
});

test('an unknown sender degrades to a phone number, never a crash', () => {
  const store = tmpStore();
  store.add(msg({ id: '1', from: '15145551234@s.whatsapp.net', name: null, at: ts('2026-11-18T10:00:00'), text: 'hello' }));
  const out = render(store, { chatName: 'g', months: 6, cutoffTs: ts('2026-05-19T00:00:00'), selfName: 'Ryan' });
  assert.match(out, /^10:00 {2}\+15145551234: hello$/m);
});

test('deduplicates — history sync and live upsert overlap constantly', () => {
  const store = tmpStore();
  const m = msg({ id: 'same', from: '1@s.whatsapp.net', name: 'A', at: ts('2026-11-18T10:00:00'), text: 'once' });
  assert.strictEqual(store.add(m), true, 'first add accepted');
  assert.strictEqual(store.add(m), false, 'duplicate rejected');
  assert.strictEqual(store.size, 1);
});

test('no line has trailing whitespace', () => {
  const store = tmpStore();
  store.add(msg({ id: '1', from: '1@s.whatsapp.net', name: 'A', at: ts('2026-11-18T10:00:00'),
    text: 'first line\n\nthird line after a blank' }));
  const out = render(store, { chatName: 'g', months: 6, cutoffTs: ts('2026-05-19T00:00:00'), selfName: 'Ryan' });
  const offenders = out.split('\n').filter((l) => /\s+$/.test(l));
  assert.deepStrictEqual(offenders, [], 'blank lines inside a message must not become whitespace');
  assert.match(out, /^ {4}third line after a blank$/m, 'real continuation lines stay indented');
});

test('the output is plain text, not markdown', () => {
  const store = tmpStore();
  store.add(msg({ id: '1', from: '1@s.whatsapp.net', name: 'A', at: ts('2026-11-18T10:00:00'), text: 'hello' }));
  const out = render(store, { chatName: 'g', months: 6, cutoffTs: ts('2026-05-19T00:00:00'), selfName: 'Ryan' });
  assert.ok(!/^#{1,6}\s/m.test(out), 'no markdown headings');
  assert.ok(!/\*\*/.test(out), 'no bold markers');
  assert.ok(!/^> /m.test(out), 'no blockquotes');
});
