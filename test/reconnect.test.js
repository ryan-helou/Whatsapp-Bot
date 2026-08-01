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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep alerting off and the outage flag out of the real data dir. Must happen
// before anything loads src/alert.js.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-'));
delete process.env.ALERT_TELEGRAM_BOT_TOKEN;
delete process.env.ALERT_TELEGRAM_CHAT_ID;

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const {
  WHATSAPP_SRC,
  installFakeClock,
  flush,
  loadModule,
  captureRuntime,
  closeEvent,
} = require('../testkit/helpers');

test('reconnect backoff grows instead of hammering every 3s', async () => {
  const clock = installFakeClock();
  const rt = captureRuntime();
  try {
    const { mod, sockets } = loadModule();
    mod.connect();
    await flush();
    assert.strictEqual(sockets.length, 1, 'first socket created');

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
    assert.ok(delays[delays.length - 1] > delays[0], `backoff must grow, got ${JSON.stringify(delays)}`);
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
    // Throw on the 2nd construction attempt only.
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
    assert.deepStrictEqual(rt.exits, [1], 'exits exactly once, non-zero, so the host restarts it');
    assert.ok(rt.logs.some((l) => /offline for \d+ min/.test(l)), 'says why it is exiting');
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
    let live;
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
