// Shared test scaffolding: a deterministic fake clock, a Baileys stub injected
// via require.cache, and console/process.exit capture. Lets the connection layer
// be exercised in milliseconds with no network and no real WhatsApp session.

const path = require('node:path');

const BAILEYS_ID = require.resolve('@whiskeysockets/baileys');
const WHATSAPP_SRC = path.join(__dirname, '..', 'src', 'whatsapp.js');
const ALERT_SRC = path.join(__dirname, '..', 'src', 'alert.js');

// ---------------------------------------------------------------------------
// Fake clock: deterministic control over setTimeout/setInterval/Date.now.
// ---------------------------------------------------------------------------
function installFakeClock() {
  const real = {
    setTimeout: global.setTimeout,
    setInterval: global.setInterval,
    clearTimeout: global.clearTimeout,
    clearInterval: global.clearInterval,
    now: Date.now,
  };
  let now = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();

  const add = (fn, ms, interval) => {
    const id = ++seq;
    timers.set(id, { time: now + (ms || 0), fn, interval });
    return { id, unref() { return this; } };
  };
  global.setTimeout = (fn, ms) => add(fn, ms, null);
  global.setInterval = (fn, ms) => add(fn, ms, ms || 1);
  global.clearTimeout = (h) => { if (h && h.id) timers.delete(h.id); };
  global.clearInterval = (h) => { if (h && h.id) timers.delete(h.id); };
  Date.now = () => now;

  return {
    get now() { return now; },
    // Run every timer due within `ms`, in time order.
    tick(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 100000; guard++) {
        let nextId = null;
        for (const [id, t] of timers) {
          if (t.time <= target && (nextId === null || t.time < timers.get(nextId).time)) nextId = id;
        }
        if (nextId === null) break;
        const t = timers.get(nextId);
        now = t.time;
        if (t.interval) t.time = now + t.interval;
        else timers.delete(nextId);
        t.fn();
      }
      now = target;
    },
    restore() { Object.assign(global, real); Date.now = real.now; },
  };
}

// Let pending promise callbacks run (real microtasks/immediates, not faked).
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Baileys stub
// ---------------------------------------------------------------------------
function makeFakeSocket(registered) {
  const handlers = {};
  return {
    ev: {
      on(evt, fn) { (handlers[evt] || (handlers[evt] = [])).push(fn); },
      removeAllListeners(evt) { delete handlers[evt]; },
    },
    authState: { creds: { registered } },
    // Test-side helpers.
    emit(evt, payload) { (handlers[evt] || []).forEach((fn) => fn(payload)); },
    captureHandlers(evt) { return (handlers[evt] || []).slice(); },
  };
}

/**
 * Install the Baileys stub and load a fresh copy of the module under test.
 * @param {object} opts
 * @param {boolean} [opts.registered] value of creds.registered on each socket
 * @param {() => void} [opts.onCreate] throw from here to simulate a socket that
 *        fails to construct; receives the attempt index (incl. failed attempts)
 * @param {string} [opts.modulePath] which implementation to load
 * @param {boolean} [opts.reloadAlert] also drop src/alert.js from the cache, so
 *        it re-reads ALERT_* env vars
 */
function loadModule({ registered = true, onCreate, modulePath = WHATSAPP_SRC, reloadAlert = false } = {}) {
  const sockets = [];
  let attempt = 0; // counts ATTEMPTS (incl. failed ones), unlike sockets.length
  require.cache[BAILEYS_ID] = {
    id: BAILEYS_ID,
    filename: BAILEYS_ID,
    loaded: true,
    exports: {
      default: () => {
        if (onCreate) onCreate(attempt++);
        const s = makeFakeSocket(registered);
        sockets.push(s);
        return s;
      },
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
      DisconnectReason: { loggedOut: 401, connectionClosed: 428, restartRequired: 515 },
    },
  };
  if (reloadAlert) delete require.cache[require.resolve(ALERT_SRC)];
  delete require.cache[require.resolve(modulePath)];
  return { mod: require(modulePath), sockets };
}

// Capture console output + process.exit without killing the test run.
function captureRuntime() {
  const logs = [];
  const realLog = console.log;
  const realErr = console.error;
  const realExit = process.exit;
  const exits = [];
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  process.exit = (code) => { exits.push(code); };
  return {
    logs,
    exits,
    restore() { console.log = realLog; console.error = realErr; process.exit = realExit; },
  };
}

const closeEvent = (statusCode) => ({
  connection: 'close',
  lastDisconnect: { error: { output: { statusCode } } },
});

module.exports = {
  BAILEYS_ID,
  WHATSAPP_SRC,
  ALERT_SRC,
  installFakeClock,
  flush,
  makeFakeSocket,
  loadModule,
  captureRuntime,
  closeEvent,
};
