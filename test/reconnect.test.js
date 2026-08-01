// Regression tests for the connection-layer outage of 2026-07-28 → 08-01.
//
// What happened: the WhatsApp socket dropped, the reconnect chain hammered every
// 3s for a day, then stopped emitting entirely. The process stayed ALIVE with a
// dead socket, so the host never restarted it and every scheduled send failed
// with "Connection Closed" for three days, silently.
//
// These tests pin the three behaviours that make that unsurvivable:
//   1. reconnect backoff grows (no more 3s hammering) and is capped
//   2. events from a superseded socket can't drive the chain
//   3. a connection that stays down takes the PROCESS down, so the host restarts
//
// Baileys is stubbed via require.cache, and timers/Date are faked, so the whole
// file runs in milliseconds with no network and no real WhatsApp session.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const BAILEYS_ID = require.resolve('@whiskeysockets/baileys');
const WHATSAPP_SRC = path.join(__dirname, '..', 'src', 'whatsapp.js');

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
    get listenerCount() { return (handlers['connection.update'] || []).length; },
  };
}

/**
 * Install the Baileys stub and load a fresh copy of the module under test.
 * @param {object} opts
 * @param {boolean} [opts.registered] value of creds.registered on each socket
 * @param {() => void} [opts.onCreate] throw from here to simulate a socket that
 *        fails to construct
 * @param {string} [opts.modulePath] which implementation to load (new or old)
 */
function loadModule({ registered = true, onCreate, modulePath = WHATSAPP_SRC } = {}) {
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

// ---------------------------------------------------------------------------

test('reconnect backoff grows instead of hammering every 3s', async () => {
  const clock = installFakeClock();
  const rt = captureRuntime();
  try {
    const { mod, sockets } = loadModule();
    mod.connect();
    await flush();
    assert.strictEqual(sockets.length, 1, 'first socket created');

    // Five consecutive drops, each followed by enough time to reconnect.
    const delays = [];
    for (let i = 0; i < 5; i++) {
      sockets[sockets.length - 1].emit('connection.update', closeEvent(428));
      const line = rt.logs[rt.logs.length - 1];
      const m = /reconnecting in (\d+)s \(attempt (\d+)\)/.exec(line);
      assert.ok(m, `expected a backoff log line, got: ${line}`);
      assert.strictEqual(Number(m[2]), i + 1, 'attempt counter increments');
      delays.push(Number(m[1]));
      clock.tick(10 * 60 * 1000); // well past any backoff
      await flush();
    }

    // The bug was a FIXED 3s retry. Prove it now escalates.
    assert.ok(
      delays[delays.length - 1] > delays[0],
      `backoff must grow, got ${JSON.stringify(delays)}`
    );
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1], `backoff must not shrink: ${JSON.stringify(delays)}`);
    }
    assert.ok(delays.every((d) => d <= 301), `backoff capped at 300s, got ${JSON.stringify(delays)}`);
    assert.strictEqual(sockets.length, 6, 'one new socket per reconnect, never two chains');
  } finally {
    rt.restore();
    clock.restore();
  }
});

test('a successful open resets the backoff counter', async () => {
  const clock = installFakeClock();
  const rt = captureRuntime();
  try {
    const { mod, sockets } = loadModule();
    mod.connect();
    await flush();

    sockets[0].emit('connection.update', closeEvent(428));
    clock.tick(10 * 60 * 1000);
    await flush();
    sockets[1].emit('connection.update', { connection: 'open' });
    sockets[1].emit('connection.update', closeEvent(428));

    const line = rt.logs[rt.logs.length - 1];
    assert.match(line, /\(attempt 1\)/, `counter should reset after an open, got: ${line}`);
  } finally {
    rt.restore();
    clock.restore();
  }
});

test('events from a superseded socket cannot drive the chain', async () => {
  const clock = installFakeClock();
  const rt = captureRuntime();
  try {
    const { mod, sockets } = loadModule();
    let readyCalls = 0;
    mod.connect(() => { readyCalls += 1; });
    await flush();

    // Grab socket #1's handler BEFORE the close path detaches it, so we can
    // replay a late event from the dead socket afterwards.
    const staleHandlers = sockets[0].captureHandlers('connection.update');
    sockets[0].emit('connection.update', closeEvent(428));
    clock.tick(10 * 60 * 1000);
    await flush();
    assert.strictEqual(sockets.length, 2, 'socket #2 is now the live one');

    sockets[1].emit('connection.update', { connection: 'open' });
    assert.strictEqual(readyCalls, 1, 'live socket reported ready');

    const socketsBefore = sockets.length;
    const logsBefore = rt.logs.length;
    // Late events from the superseded socket #1 must be ignored entirely.
    staleHandlers.forEach((fn) => fn({ connection: 'open' }));
    staleHandlers.forEach((fn) => fn(closeEvent(428)));

    assert.strictEqual(readyCalls, 1, 'stale open must not re-fire onReady');
    assert.strictEqual(sockets.length, socketsBefore, 'stale close must not start a second chain');
    assert.strictEqual(rt.logs.length, logsBefore, 'stale events must not log');
  } finally {
    rt.restore();
    clock.restore();
  }
});

test('a socket that fails to construct still retries', async () => {
  const clock = installFakeClock();
  const rt = captureRuntime();
  try {
    // Throw on the 2nd construction only.
    const { mod, sockets } = loadModule({
      onCreate: (n) => { if (n === 1) throw new Error('boom'); },
    });
    mod.connect();
    await flush();

    sockets[0].emit('connection.update', closeEvent(428));
    clock.tick(10 * 60 * 1000); // reconnect #1 throws inside makeWASocket
    await flush();
    clock.tick(10 * 60 * 1000); // must still schedule another attempt
    await flush();

    assert.ok(
      rt.logs.some((l) => /Could not open WhatsApp socket: boom/.test(l)),
      'construction failure is reported'
    );
    assert.strictEqual(sockets.length, 2, 'chain survived the throw and built a new socket');
  } finally {
    rt.restore();
    clock.restore();
  }
});

test('watchdog exits the process when the connection stays down', async () => {
  const clock = installFakeClock();
  const rt = captureRuntime();
  try {
    const { mod, sockets } = loadModule();
    mod.connect();
    await flush();
    sockets[0].emit('connection.update', closeEvent(428));

    // 14 minutes: still under the 15-minute threshold.
    clock.tick(14 * 60 * 1000);
    await flush();
    assert.deepStrictEqual(rt.exits, [], 'must not exit before the threshold');

    // Past the threshold.
    clock.tick(3 * 60 * 1000);
    await flush();
    assert.deepStrictEqual(rt.exits, [1], 'exits non-zero so the host restarts it');
    assert.ok(
      rt.logs.some((l) => /offline for \d+ min/.test(l)),
      'says why it is exiting'
    );
  } finally {
    rt.restore();
    clock.restore();
  }
});

test('watchdog does not fire while the connection is healthy', async () => {
  const clock = installFakeClock();
  const rt = captureRuntime();
  try {
    const { mod, sockets } = loadModule();
    mod.connect();
    await flush();
    sockets[0].emit('connection.update', { connection: 'open' });

    clock.tick(6 * 60 * 60 * 1000); // six hours connected
    await flush();
    assert.deepStrictEqual(rt.exits, [], 'a healthy connection is never killed');
  } finally {
    rt.restore();
    clock.restore();
  }
});

test('onLost fires on every drop so callers stop using the dead socket', async () => {
  const clock = installFakeClock();
  const rt = captureRuntime();
  try {
    const { mod, sockets } = loadModule();
    let live = undefined;
    mod.connect((s) => { live = s; }, () => { live = null; });
    await flush();

    sockets[0].emit('connection.update', { connection: 'open' });
    assert.ok(live, 'socket handed to caller on open');

    sockets[0].emit('connection.update', closeEvent(428));
    assert.strictEqual(live, null, 'caller told to drop the dead socket');

    clock.tick(10 * 60 * 1000);
    await flush();
    sockets[1].emit('connection.update', { connection: 'open' });
    assert.strictEqual(live, sockets[1], 'caller gets the NEW socket after reconnect');
  } finally {
    rt.restore();
    clock.restore();
  }
});

// ---------------------------------------------------------------------------
// The zombie the outage actually produced, proven against the OLD code.
// ---------------------------------------------------------------------------
test('OLD code went zombie on a post-link logout; new code does not', async (t) => {
  // Snapshot the pre-fix implementation next to the source so its `require`s
  // still resolve against the project's node_modules.
  const oldPath = path.join(__dirname, '..', 'src', '.whatsapp.prefix.snapshot.js');
  let oldSource;
  try {
    oldSource = execFileSync('git', ['show', '2300c7c:src/whatsapp.js'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
  } catch (err) {
    t.skip(`could not read pre-fix source from git: ${err.message}`);
    return;
  }
  fs.writeFileSync(oldPath, oldSource);

  const scenario = async (modulePath) => {
    const clock = installFakeClock();
    const rt = captureRuntime();
    try {
      const { mod, sockets } = loadModule({ modulePath });
      mod.connect();
      await flush();
      // Link succeeds, then WhatsApp logs the device out.
      sockets[0].emit('connection.update', { connection: 'open' });
      sockets[0].emit('connection.update', closeEvent(401));
      // Give it a long time to do *something* about it.
      clock.tick(60 * 60 * 1000);
      await flush();
      return { exits: rt.exits.slice(), socketCount: sockets.length };
    } finally {
      rt.restore();
      clock.restore();
    }
  };

  try {
    const before = await scenario(oldPath);
    assert.deepStrictEqual(
      before.exits,
      [],
      'reproduces the bug: old code never exited, so the host never restarted it'
    );
    assert.strictEqual(before.socketCount, 1, 'old code also never reconnected — a live zombie');

    // NB: process.exit is stubbed here, so execution continues and the watchdog
    // records a second exit that a real process would never reach. What matters
    // is that it exits at all, non-zero.
    const after = await scenario(WHATSAPP_SRC);
    assert.ok(after.exits.length > 0, 'new code exits so the host restarts it');
    assert.ok(after.exits.every((c) => c === 1), `exit code must be non-zero, got ${after.exits}`);
  } finally {
    fs.rmSync(oldPath, { force: true });
  }
});
