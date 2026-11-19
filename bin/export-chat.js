#!/usr/bin/env node
// Export one WhatsApp chat's history to a log that's readable by both a human
// and an AI.
//
//   npm run export-chat -- --list
//   npm run export-chat -- --group "English ministry (music)" --months 6
//
// Design notes:
//  * This opens its OWN WhatsApp session (default ./export-session) and builds
//    its own socket. It deliberately does NOT use src/whatsapp.js, because that
//    module carries the scheduler's watchdog (exits after 15 min offline) and
//    its Telegram alerting — neither of which belongs in a long export run.
//    It must never be pointed at the bot's production session.
//  * History arrives asynchronously: `fetchMessageHistory` only REQUESTS older
//    messages; they land later on the `messaging-history.set` event. So the
//    pager asks, waits for the oldest-known timestamp to move, and repeats.
//  * Everything is appended to a raw .jsonl as it arrives, so a run that dies
//    halfway is still worth something and can be re-rendered without re-pulling.

const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const { DateTime } = require('luxon');

// ---------------------------------------------------------------- args ----
function parseArgs(argv) {
  const out = { months: 6, auth: 'export-session', outDir: 'exports', batch: 50 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--group') out.group = next();
    else if (a === '--jid') out.jid = next();
    else if (a === '--months') out.months = Number(next());
    else if (a === '--auth') out.auth = next();
    else if (a === '--out') out.outDir = next();
    else if (a === '--batch') out.batch = Number(next());
    else if (a === '--list') out.list = true;
    else if (a === '--render-only') out.renderOnly = next(); // path to a raw .jsonl
  }
  return out;
}
const ARGS = parseArgs(process.argv);
const TZ = process.env.DEFAULT_TIMEZONE || 'America/Toronto';

const log = (...a) => console.log(...a);

// ------------------------------------------------------- message shapes ----
// Turn a Baileys message object into { text, kind } for the log.
function describe(m) {
  const msg = m.message || {};
  const inner = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message
    || msg.viewOnceMessageV2?.message || msg.documentWithCaptionMessage?.message || msg;

  if (inner.conversation) return { text: inner.conversation, kind: 'text' };
  if (inner.extendedTextMessage?.text) return { text: inner.extendedTextMessage.text, kind: 'text' };
  if (inner.imageMessage) return { text: inner.imageMessage.caption || '', kind: 'image' };
  if (inner.videoMessage) return { text: inner.videoMessage.caption || '', kind: 'video' };
  if (inner.audioMessage) {
    const secs = inner.audioMessage.seconds;
    return { text: secs ? `${secs}s` : '', kind: inner.audioMessage.ptt ? 'voice note' : 'audio' };
  }
  if (inner.documentMessage) {
    return { text: [inner.documentMessage.fileName, inner.documentMessage.caption].filter(Boolean).join(' — '), kind: 'document' };
  }
  if (inner.stickerMessage) return { text: '', kind: 'sticker' };
  if (inner.contactMessage) return { text: inner.contactMessage.displayName || '', kind: 'contact' };
  if (inner.locationMessage) return { text: '', kind: 'location' };
  if (inner.pollCreationMessage || inner.pollCreationMessageV3) {
    const p = inner.pollCreationMessage || inner.pollCreationMessageV3;
    const opts = (p.options || []).map((o) => o.optionName).filter(Boolean);
    return { text: [p.name, opts.length ? `(${opts.join(' / ')})` : ''].filter(Boolean).join(' '), kind: 'poll' };
  }
  if (inner.reactionMessage) return { text: inner.reactionMessage.text || '', kind: 'reaction' };
  if (inner.protocolMessage?.type === 0) return { text: '', kind: 'deleted' };
  if (msg.senderKeyDistributionMessage && Object.keys(msg).length === 1) return null; // plumbing
  return { text: '', kind: 'unsupported' };
}

function quotedTextOf(m) {
  const ctx = m.message?.extendedTextMessage?.contextInfo;
  const q = ctx?.quotedMessage;
  if (!q) return null;
  const d = describe({ message: q });
  const t = (d?.text || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 60 ? `${t.slice(0, 57)}…` : t) : (d?.kind || null);
}

// --------------------------------------------------------------- store ----
class Store {
  constructor(rawPath) {
    this.byId = new Map();
    this.rawPath = rawPath;
    this.names = new Map(); // jid -> display name
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    this.raw = fs.createWriteStream(rawPath, { flags: 'a' });
  }
  noteName(jid, name) {
    if (!jid || !name) return;
    const clean = String(name).trim();
    if (clean && !this.names.has(jid)) this.names.set(jid, clean);
  }
  add(m) {
    const id = m.key?.id;
    if (!id || this.byId.has(id)) return false;
    this.byId.set(id, m);
    this.raw.write(JSON.stringify(m) + '\n');
    this.noteName(m.key?.participant || m.participant, m.pushName);
    return true;
  }
  get size() { return this.byId.size; }
  oldest() {
    let best = null;
    for (const m of this.byId.values()) {
      const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
      if (!ts) continue;
      if (!best || ts < best.ts) best = { ts, key: m.key };
    }
    return best;
  }
  close() { try { this.raw.end(); } catch (_) {} }
}

// -------------------------------------------------------------- render ----
function displayName(store, m, selfName) {
  if (m.key?.fromMe) return selfName;
  const jid = m.key?.participant || m.participant || m.key?.remoteJid || '';
  const known = store.names.get(jid);
  if (known) return known;
  if (m.pushName) return m.pushName;
  const user = String(jid).split('@')[0].split(':')[0];
  return user ? `+${user}` : 'Unknown';
}

function render(store, meta) {
  const msgs = [...store.byId.values()]
    .map((m) => ({ m, ts: Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) }))
    .filter((x) => x.ts >= meta.cutoffTs)
    .sort((a, b) => a.ts - b.ts);

  const lines = [];
  const participants = new Map();

  let currentDay = null;
  const body = [];
  for (const { m, ts } of msgs) {
    const d = describe(m);
    if (!d) continue;
    const dt = DateTime.fromSeconds(ts, { zone: TZ });
    const day = dt.toFormat('yyyy-LL-dd');
    if (day !== currentDay) {
      currentDay = day;
      body.push('', `## ${day} (${dt.toFormat('cccc')})`, '');
    }
    const who = displayName(store, m, meta.selfName);
    participants.set(who, (participants.get(who) || 0) + 1);

    const prefix = `${dt.toFormat('HH:mm')}  ${who}: `;
    const tags = [];
    if (d.kind !== 'text') tags.push(`[${d.kind}]`);
    const quoted = quotedTextOf(m);
    if (quoted) tags.push(`[re: ${quoted}]`);

    const text = (d.text || '').replace(/\r/g, '');
    const first = [tags.join(' '), text.split('\n')[0]].filter(Boolean).join(' ');
    body.push(prefix + first);
    // Continuation lines, indented so a reader (and a parser) can tell they
    // belong to the message above rather than being new messages.
    for (const extra of text.split('\n').slice(1)) {
      // Keep blank lines genuinely blank rather than four spaces of trailing
      // whitespace; a continuation line is "any line not starting HH:MM  ".
      body.push(extra.trim() === '' ? '' : '    ' + extra);
    }
  }

  const sortedPeople = [...participants.entries()].sort((a, b) => b[1] - a[1]);
  const first = msgs[0] ? DateTime.fromSeconds(msgs[0].ts, { zone: TZ }) : null;
  const last = msgs[msgs.length - 1] ? DateTime.fromSeconds(msgs[msgs.length - 1].ts, { zone: TZ }) : null;

  lines.push(`# ${meta.chatName} — message log`);
  lines.push('');
  lines.push(`- **Exported:** ${DateTime.now().setZone(TZ).toFormat('yyyy-LL-dd HH:mm ZZZZ')}`);
  lines.push(`- **Requested window:** last ${meta.months} months (from ${DateTime.fromSeconds(meta.cutoffTs, { zone: TZ }).toFormat('yyyy-LL-dd')})`);
  lines.push(`- **Actually covers:** ${first ? first.toFormat('yyyy-LL-dd') : '—'} → ${last ? last.toFormat('yyyy-LL-dd') : '—'}`);
  lines.push(`- **Messages:** ${msgs.length}`);
  lines.push(`- **Participants seen:** ${sortedPeople.length}`);
  lines.push(`- **Times:** ${TZ}, 24-hour`);
  lines.push('');
  if (meta.coverageWarning) {
    lines.push(`> ⚠️ ${meta.coverageWarning}`);
    lines.push('');
  }
  lines.push('**Format.** Each day is a `## YYYY-MM-DD (Weekday)` heading. Each message is');
  lines.push('`HH:MM  Sender: text` on one line. Any line that does NOT start with `HH:MM  `');
  lines.push('is a continuation of the message above it (indented 4 spaces; blank lines kept).');
  lines.push('`[image]`, `[voice note]`, `[poll]`');
  lines.push('etc. mark non-text messages; `[re: …]` marks a reply and quotes what it replied to.');
  lines.push('');
  lines.push('**Who speaks here** (by message count): ' + sortedPeople.map(([n, c]) => `${n} (${c})`).join(', '));
  lines.push('');
  lines.push('---');
  lines.push(...body);
  lines.push('');
  return lines.join('\n');
}

// ------------------------------------------------------------- connect ----
async function main() {
  const cutoffTs = Math.floor(DateTime.now().setZone(TZ).minus({ months: ARGS.months }).toSeconds());

  // Re-render an earlier raw pull without touching WhatsApp at all.
  if (ARGS.renderOnly) {
    const store = new Store(path.join(ARGS.outDir, '.rerender-scratch.jsonl'));
    for (const line of fs.readFileSync(ARGS.renderOnly, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { store.add(JSON.parse(line)); } catch (_) {}
    }
    const out = path.join(ARGS.outDir, 'rendered.md');
    fs.writeFileSync(out, render(store, {
      chatName: ARGS.group || 'chat', months: ARGS.months, cutoffTs, selfName: 'Ryan',
    }));
    log(`Rendered ${store.size} stored message(s) → ${out}`);
    store.close();
    process.exit(0);
  }

  if (ARGS.auth.replace(/\/$/, '') === 'railway-session') {
    console.error('Refusing to use railway-session — that is the production bot session.');
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(ARGS.auth);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Chat Exporter', 'Chrome', '1.0.0'],
    syncFullHistory: true, // the whole point: ask for history on link
    markOnlineOnConnect: false,
  });
  sock.ev.on('creds.update', saveCreds);

  let store = null;
  let targetJid = ARGS.jid || null;
  let lastArrival = Date.now();
  const pendingNames = [];

  const ingest = (messages = []) => {
    if (!store || !targetJid) {
      for (const m of messages) pendingNames.push(m);
      return;
    }
    let added = 0;
    for (const m of messages) {
      if (m?.key?.remoteJid !== targetJid) continue;
      if (store.add(m)) added++;
    }
    if (added) lastArrival = Date.now();
  };

  sock.ev.on('messaging-history.set', ({ messages = [], contacts = [], progress, syncType }) => {
    for (const c of contacts) {
      const nm = c.name || c.notify || c.verifiedName;
      if (store) store.noteName(c.id, nm);
      else pendingNames.push({ _contact: true, id: c.id, name: nm });
    }
    ingest(messages);
    if (progress != null) process.stdout.write(`\r  history sync ${progress}%   `);
  });
  sock.ev.on('messages.upsert', ({ messages }) => ingest(messages));

  await new Promise((resolve, reject) => {
    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        log('\nScan this in WhatsApp → Settings → Linked Devices → Link a Device:\n');
        qrcodeTerminal.generate(qr, { small: true });
        const png = path.resolve(ARGS.outDir, 'link-qr.png');
        QRCode.toFile(png, qr, { width: 512, margin: 2 })
          .then(() => log(`\n(Also saved as an image you can scan: ${png})\n`))
          .catch(() => {});
      }
      if (connection === 'open') resolve();
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          reject(new Error(
            `This session (${ARGS.auth}) is logged out — WhatsApp drops linked devices after ~14 days idle. ` +
            `Delete the folder and re-run to get a fresh QR.`
          ));
        } else {
          log(`\n(connection closed, code ${code} — reconnect by re-running)`);
          reject(new Error('connection closed before sync finished'));
        }
      }
    });
  });

  log('✓ Connected.');
  await new Promise((r) => setTimeout(r, 2500));

  const groups = await sock.groupFetchAllParticipating();
  const rows = Object.values(groups).map((g) => ({
    jid: g.id, name: g.subject || '(unnamed)', size: g.participants?.length ?? 0,
  })).sort((a, b) => a.name.localeCompare(b.name));

  if (ARGS.list) {
    log(`\nIn ${rows.length} group(s):\n`);
    for (const r of rows) log(`  • ${r.name}  (${r.size})\n      ${r.jid}`);
    process.exit(0);
  }

  if (!targetJid) {
    const q = String(ARGS.group || '').toLowerCase().trim();
    if (!q) throw new Error('Pass --group "<name>" or --jid <id>, or --list to see them.');
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    let hits = rows.filter((r) => r.name.toLowerCase() === q);
    if (!hits.length) hits = rows.filter((r) => norm(r.name) === norm(q));
    if (!hits.length) hits = rows.filter((r) => norm(r.name).includes(norm(q)));
    if (!hits.length) throw new Error(`No group matching "${ARGS.group}". Run with --list to see names.`);
    if (hits.length > 1) {
      throw new Error(`"${ARGS.group}" matches ${hits.length} groups:\n` + hits.map((h) => `   ${h.name}  ${h.jid}`).join('\n'));
    }
    targetJid = hits[0].jid;
    ARGS.group = hits[0].name;
  }
  const chatName = (rows.find((r) => r.jid === targetJid) || {}).name || ARGS.group || targetJid;
  log(`Target: ${chatName}  (${targetJid})`);

  const slug = chatName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const rawPath = path.join(ARGS.outDir, `${slug}.raw.jsonl`);
  store = new Store(rawPath);
  for (const p of pendingNames) {
    if (p._contact) store.noteName(p.id, p.name);
    else if (p?.key?.remoteJid === targetJid) store.add(p);
  }

  // Name the account itself.
  const selfName = sock.user?.name || sock.user?.verifiedName || 'Me';

  // Let the initial history sync settle: stop when nothing new has landed for
  // a few seconds (history arrives in bursts, so we wait out the quiet).
  log('Waiting for the initial history sync to settle…');
  lastArrival = Date.now();
  const SETTLE_MS = 8000;
  while (Date.now() - lastArrival < SETTLE_MS) await new Promise((r) => setTimeout(r, 500));
  log(`\n  initial sync gave ${store.size} message(s) for this chat.`);

  // Page backwards until we pass the cutoff or the server stops going older.
  let stalls = 0;
  let coverageWarning = null;
  while (true) {
    const oldest = store.oldest();
    if (!oldest) { coverageWarning = 'WhatsApp returned no messages at all for this chat.'; break; }
    if (oldest.ts <= cutoffTs) break;

    const before = store.size;
    const oldestBefore = oldest.ts;
    const when = DateTime.fromSeconds(oldest.ts, { zone: TZ }).toFormat('yyyy-LL-dd');
    process.stdout.write(`\r  oldest so far ${when} — asking for ${ARGS.batch} older…      `);

    try {
      await sock.fetchMessageHistory(ARGS.batch, oldest.key, oldest.ts);
    } catch (err) {
      coverageWarning = `Stopped early: WhatsApp refused a history request (${err.message}).`;
      break;
    }

    // The reply arrives on the history event, so wait for the oldest to move.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const now = store.oldest();
      if (now && now.ts < oldestBefore) break;
    }

    const after = store.oldest();
    if (!after || after.ts >= oldestBefore || store.size === before) {
      stalls++;
      if (stalls >= 3) {
        coverageWarning =
          `WhatsApp stopped serving older messages at ${DateTime.fromSeconds(oldestBefore, { zone: TZ }).toFormat('yyyy-LL-dd')}. ` +
          `On-demand history is rate-limited and capped by the server, so this is as far back as it will go right now — ` +
          `re-running later often gets more.`;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      stalls = 0;
    }
  }

  const outPath = path.join(ARGS.outDir, `${slug}.md`);
  fs.writeFileSync(outPath, render(store, {
    chatName, months: ARGS.months, cutoffTs, selfName, coverageWarning,
  }));
  store.close();

  log(`\n\n✓ ${store.size} message(s) stored.`);
  log(`  readable log: ${outPath}`);
  log(`  raw data:     ${rawPath}`);
  if (coverageWarning) log(`  ⚠ ${coverageWarning}`);
  process.exit(0);
}

// Only run the CLI when invoked directly, so the pure helpers above can be
// unit-tested without opening a WhatsApp socket.
if (require.main === module) {
  main().catch((err) => {
    console.error('\nExport failed:', err.message);
    process.exit(1);
  });
}

module.exports = { describe, quotedTextOf, displayName, render, Store };
