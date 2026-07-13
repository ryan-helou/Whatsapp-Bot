// Tiny persistent store (single JSON file). Two jobs:
//   1. Dedupe — never send the same row twice on the same day, even across restarts.
//   2. Send log — a record of every attempt (ok/failed) for you to inspect.
// No native deps, single-process, synchronous writes = simple and reliable.

const fs = require('fs');
const path = require('path');

const PRUNE_AFTER_DAYS = 14;
const MAX_LOG = 1000;

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    this.dataDir = dataDir;
    this.state = { sent: {}, log: [] };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.state.sent = this.state.sent || {};
        this.state.log = this.state.log || [];
        this._prune();
      } else {
        fs.mkdirSync(this.dataDir, { recursive: true });
        this._save();
      }
    } catch (err) {
      console.error('Could not read state file, starting fresh:', err.message);
      this.state = { sent: {}, log: [] };
    }
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file); // atomic replace
  }

  _prune() {
    const cutoff = Date.now() - PRUNE_AFTER_DAYS * 86400_000;
    for (const [key, rec] of Object.entries(this.state.sent)) {
      if (rec && rec.ts && rec.ts < cutoff) delete this.state.sent[key];
    }
    if (this.state.log.length > MAX_LOG) {
      this.state.log = this.state.log.slice(-MAX_LOG);
    }
  }

  // Already handled today? (sent or currently sending)
  isHandled(key) {
    const rec = this.state.sent[key];
    return !!rec && (rec.status === 'sent' || rec.status === 'sending');
  }

  // On startup, drop reservations left in 'sending' by a crash so those rows
  // can be re-evaluated instead of being stuck forever.
  clearStaleSending() {
    let cleared = 0;
    for (const [key, rec] of Object.entries(this.state.sent)) {
      if (rec && rec.status === 'sending') {
        delete this.state.sent[key];
        cleared++;
      }
    }
    if (cleared) this._save();
    return cleared;
  }

  // Reserve a key before sending so a second tick can't double-fire it.
  // Returns true if we got the reservation, false if someone already has it.
  reserve(key) {
    if (this.isHandled(key)) return false;
    this.state.sent[key] = { status: 'sending', ts: Date.now() };
    this._save();
    return true;
  }

  markSent(key, info) {
    this.state.sent[key] = { status: 'sent', ts: Date.now() };
    this._append({ ...info, status: 'sent', at: new Date().toISOString() });
  }

  // On failure we DROP the reservation so it isn't blocked, but record 'failed'
  // in the log. We don't auto-retry the same row again today (the sender already
  // retried internally) — you'll see the failure in the log.
  markFailed(key, info) {
    this.state.sent[key] = { status: 'failed', ts: Date.now() };
    this._append({ ...info, status: 'failed', at: new Date().toISOString() });
  }

  _append(entry) {
    this.state.log.push(entry);
    this._prune();
    this._save();
  }

  recentLog(n = 20) {
    return this.state.log.slice(-n);
  }
}

module.exports = { Store };
