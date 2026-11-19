#!/usr/bin/env node
// Convert WhatsApp's own "Export chat" output (_chat.txt) into the same
// structured log bin/export-chat.js produces.
//
//   npm run import-wa -- --file ~/Downloads/chat-export/_chat.txt \
//                        --name "English ministry (music)" --months 6
//
// WhatsApp's export is the most complete source available — it comes from the
// phone itself, so unlike an API history pull there are no server-side caps or
// gaps. The quirks it carries:
//   * times use a NARROW NO-BREAK SPACE (U+202F) before AM/PM, not a space
//   * system events and attachments are flagged with a LEFT-TO-RIGHT MARK
//     (U+200E) at the start of the text — that mark is the only reliable
//     signal distinguishing "Joe created this group" from Joe saying it
//   * `<attached: file>` can sit on the first line of a message OR on a later
//     line, after a caption
//   * a `~` before a name means WhatsApp had no contact entry for them

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { render, Store } = require('./export-chat.js');

const LRM = '‎';
const NBSP = '[\\s\\u202f\\u00a0]';

const HEAD = new RegExp(
  `^[\\u200e\\u200f]*\\[(\\d{4}-\\d{2}-\\d{2}), (\\d{1,2}):(\\d{2}):(\\d{2})${NBSP}*([AP]M)\\]${NBSP}*(.*)$`
);
const ATTACHED = /[‎]?<attached:\s*([^>]+)>/g;

const tidy = (s) => String(s).replace(/[  ]/g, ' ').replace(/^~\s*/, '').trim();

function kindFromFile(file) {
  const f = file.toUpperCase();
  if (/-PHOTO-|\.(JPG|JPEG|PNG|WEBP|HEIC)$/.test(f)) return 'image';
  if (/-VIDEO-|\.(MP4|MOV|3GP|MKV)$/.test(f)) return 'video';
  if (/-AUDIO-|\.(MP3|OGG|M4A|WAV|OPUS)$/.test(f)) return 'audio';
  if (/-STICKER-|\.WEBP$/.test(f)) return 'sticker';
  return 'document';
}

// Build a Baileys-shaped message so the existing renderer can format it.
function toMessage(entry, idx, tz) {
  const dt = DateTime.fromFormat(
    `${entry.date} ${entry.time} ${entry.meridiem}`,
    'yyyy-MM-dd h:mm:ss a',
    { zone: tz }
  );
  const key = { id: `imported-${idx}`, remoteJid: 'imported@g.us', participant: `${entry.sender || 'system'}@imported`, fromMe: false };
  const base = { key, pushName: entry.sender || 'system', messageTimestamp: Math.floor(dt.toSeconds()) };

  if (entry.attachments.length) {
    const file = entry.attachments[0];
    const caption = [entry.text, `(file: ${entry.attachments.join(', ')})`].filter(Boolean).join(' ');
    switch (kindFromFile(file)) {
      case 'image': return { ...base, message: { imageMessage: { caption } } };
      case 'video': return { ...base, message: { videoMessage: { caption } } };
      case 'audio': return { ...base, message: { audioMessage: { ptt: true, seconds: 0 } }, _audioCaption: caption };
      case 'sticker': return { ...base, message: { stickerMessage: {} } };
      default: return { ...base, message: { documentMessage: { fileName: file, caption: entry.text || undefined } } };
    }
  }
  return { ...base, message: { conversation: entry.text } };
}

/**
 * Parse a WhatsApp _chat.txt into intermediate entries.
 * @param {string} raw file contents
 * @param {string} chatName used to recognise group-level system messages
 */
function parseExport(raw, chatName) {
  const lines = raw.split(/\r?\n/);
  const entries = [];
  let cur = null;

  const finish = () => {
    if (!cur) return;
    let text = cur.rawText.join('\n');
    const attachments = [];
    text = text.replace(ATTACHED, (_, file) => { attachments.push(file.trim()); return ''; });
    // A leading LRM marks a system event or an attachment, never ordinary text.
    const flagged = cur.rawText[0] ? cur.rawText[0].startsWith(LRM) : false;
    cur.attachments = attachments;
    cur.text = tidy(text.replace(/‎/g, '')).replace(/\n{3,}/g, '\n\n');
    cur.system = !!(flagged && !attachments.length) || cur.sender === chatName;
    if (cur.system) cur.sender = null;
    entries.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const m = HEAD.exec(line);
    if (m) {
      finish();
      const [, date, h, mm, ss, meridiem, rest] = m;
      let sender = null;
      let body = rest;
      const split = rest.indexOf(': ');
      if (split > -1) {
        sender = tidy(rest.slice(0, split));
        body = rest.slice(split + 2);
      }
      cur = { date, time: `${h}:${mm}:${ss}`, meridiem, sender, rawText: [body] };
    } else if (cur) {
      cur.rawText.push(line);
    }
    // Lines before the first timestamp are export preamble; ignore them.
  }
  finish();
  return entries;
}

function parseArgs(argv) {
  const out = { months: 6, tz: process.env.DEFAULT_TIMEZONE || 'America/Toronto', outDir: 'exports' };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--file': out.file = next(); break;
      case '--name': out.name = next(); break;
      case '--months': out.months = Number(next()); break;
      case '--since': out.since = next(); break;
      case '--all': out.months = 0; break;
      case '--out': out.outDir = next(); break;
    }
  }
  return out;
}

function main() {
  const ARGS = parseArgs(process.argv);
  if (!ARGS.file) throw new Error('Pass --file <path to _chat.txt>');
  const chatName = ARGS.name || path.basename(path.dirname(path.resolve(ARGS.file)));

  const raw = fs.readFileSync(ARGS.file, 'utf8');
  const entries = parseExport(raw, chatName);

  const cutoff = ARGS.since
    ? DateTime.fromISO(ARGS.since, { zone: ARGS.tz }).startOf('day')
    : ARGS.months > 0
      ? DateTime.now().setZone(ARGS.tz).minus({ months: ARGS.months }).startOf('day')
      : DateTime.fromSeconds(0, { zone: ARGS.tz });
  const cutoffTs = Math.floor(cutoff.toSeconds());

  fs.mkdirSync(ARGS.outDir, { recursive: true });
  const slug = chatName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const store = new Store(path.join(ARGS.outDir, `${slug}.raw.jsonl`));
  entries.forEach((e, i) => store.add(toMessage(e, i, ARGS.tz)));

  const outPath = path.join(ARGS.outDir, `${slug}.txt`);
  fs.writeFileSync(outPath, render(store, {
    chatName,
    months: ARGS.months,
    windowLabel: ARGS.months > 0 ? null : 'entire exported history',
    cutoffTs,
    selfName: 'Ryan',
    coverageWarning: null, // a phone-side export has no server-side gaps
  }));
  store.close();

  const kept = entries.filter((e) => {
    const dt = DateTime.fromFormat(`${e.date} ${e.time} ${e.meridiem}`, 'yyyy-MM-dd h:mm:ss a', { zone: ARGS.tz });
    return dt.toSeconds() >= cutoffTs;
  }).length;
  console.log(`Parsed ${entries.length} message(s) from the export.`);
  console.log(`Kept ${kept} inside the window (from ${cutoff.toFormat('yyyy-LL-dd')}).`);
  console.log(`→ ${outPath}`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error('Import failed:', err.message); process.exit(1); }
}

module.exports = { parseExport, toMessage, kindFromFile, HEAD };
