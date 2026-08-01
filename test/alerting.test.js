// Tests for the alerting path added after the Jul-28 → Aug-01 outage.
//
// The outage lasted three days because a broken bot and a working bot looked
// identical from the outside. These tests pin the behaviours that make a failure
// reach Ryan: connection down, watchdog restart, logout (the one a restart can't
// fix), and recovery — including recovery that happens via a process restart,
// where a fresh process has no in-memory knowledge of the outage.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before anything loads src/alert.js — it reads these at load time.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-alerting-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ALERT_TELEGRAM_BOT_TOKEN = 'TEST-TOKEN';
process.env.ALERT_TELEGRAM_CHAT_ID = '123456';
process.env.ALERT_REPEAT_MINUTES = '30';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  ALERT_SRC,
  installFakeClock,
  flush,
  loadModule,
  captureRuntime,
  closeEvent,
} = require('../testkit/helpers');

// --- fetch stub ------------------------------------------------------------
function captureFetch({ ok = true, status = 200, reject = false } = {}) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (reject) throw new Error('network down');
    return { ok, status };
  };
  return {
    calls,
    texts: () => calls.map((c) => c.body.text),
    restore() { global.fetch = real; },
  };
}

const freshAlert = () => {
  delete require.cache[require.resolve(ALERT_SRC)];
  return require(ALERT_SRC);
};

const clearFlag = () => fs.rmSync(path.join(DATA_DIR, 'outage.flag'), { force: true });

// ---------------------------------------------------------------------------
// The alert module itself
// ---------------------------------------------------------------------------

test('sends to the configured chat via the Telegram API', async () => {
  const fetchStub = captureFetch();
  try {
    const a = freshAlert();
    assert.strictEqual(a.enabled(), true);
    assert.strictEqual(await a.alert('k', 'hello'), true);
    assert.strictEqual(fetchStub.calls.length, 1);
    assert.match(fetchStub.calls[0].url, /api\.telegram\.org\/botTEST-TOKEN\/sendMessage/);
    assert.strictEqual(fetchStub.calls[0].body.chat_id, '123456');
    assert.strictEqual(fetchStub.calls[0].body.text, 'hello');
  } finally {
    fetchStub.restore();
  }
});

test('does nothing when no token is configured', async () => {
  const fetchStub = captureFetch();
  const token = process.env.ALERT_TELEGRAM_BOT_TOKEN;
  delete process.env.ALERT_TELEGRAM_BOT_TOKEN;
  try {
    const a = freshAlert();
    assert.strictEqual(a.enabled(), false);
    assert.strictEqual(await a.alert('k', 'hello'), false);
    assert.strictEqual(fetchStub.calls.length, 0, 'must not call the network');
  } finally {
    process.env.ALERT_TELEGRAM_BOT_TOKEN = token;
    fetchStub.restore();
  }
});

test('throttles repeats so a flapping connection cannot spam', async () => {
  const clock = installFakeClock();
  const fetchStub = captureFetch();
  try {
    const a = freshAlert();
    assert.strictEqual(await a.alert('same', 'first'), true);
    assert.strictEqual(await a.alert('same', 'second'), false, 'dropped inside the window');
    assert.strictEqual(await a.alert('other', 'different key'), true, 'other keys unaffected');
    assert.strictEqual(fetchStub.calls.length, 2);

    clock.tick(31 * 60 * 1000); // past ALERT_REPEAT_MINUTES
    assert.strictEqual(await a.alert('same', 'third'), true, 'allowed again after the window');
    assert.strictEqual(fetchStub.calls.length, 3);
  } finally {
    fetchStub.restore();
    clock.restore();
  }
});

test('force bypasses throttling for high-signal events', async () => {
  const fetchStub = captureFetch();
  try {
    const a = freshAlert();
    await a.alert('k', 'first');
    assert.strictEqual(await a.alert('k', 'second', { force: true }), true);
    assert.strictEqual(fetchStub.calls.length, 2);
  } finally {
    fetchStub.restore();
  }
});

test('never throws when Telegram fails — alerting must not break the bot', async () => {
  for (const opts of [{ reject: true }, { ok: false, status: 502 }]) {
    const fetchStub = captureFetch(opts);
    const rt = captureRuntime();
    try {
      const a = freshAlert();
      assert.strictEqual(await a.alert('k', 'hello'), false, `returns false for ${JSON.stringify(opts)}`);
      assert.ok(
        rt.logs.some((l) => /not delivered/.test(l)),
        'the failure is logged rather than swallowed'
      );
    } finally {
      rt.restore();
      fetchStub.restore();
    }
  }
});

test('the outage flag round-trips on disk', () => {
  const a = freshAlert();
  clearFlag();
  assert.strictEqual(a.outageInfo(), null, 'starts clean');
  a.markOutage('because');
  assert.strictEqual(a.outageInfo().reason, 'because');
  a.clearOutage();
  assert.strictEqual(a.outageInfo(), null, 'cleared');
});

// ---------------------------------------------------------------------------
// Wiring into the connection lifecycle
// ---------------------------------------------------------------------------

test('alerts that the connection is down before the watchdog restarts', async () => {
  const clock = installFakeClock();
  const fetchStub = captureFetch();
  const rt = captureRuntime();
  clearFlag();
  try {
    const { mod, sockets } = loadModule({ reloadAlert: true });
    mod.connect();
    await flush();
    sockets[0].emit('connection.update', closeEvent(428));

    // Under ALERT_OFFLINE_MINUTES (5): still quiet.
    clock.tick(4 * 60 * 1000);
    await flush();
    assert.strictEqual(fetchStub.calls.length, 0, 'no alert before the threshold');

    // Past it: one alert, and the outage recorded on disk.
    clock.tick(2 * 60 * 1000);
    await flush();
    assert.strictEqual(fetchStub.calls.length, 1, 'exactly one alert, not one per 30s tick');
    assert.match(fetchStub.texts()[0], /connection down/i);
    assert.ok(freshAlert().outageInfo(), 'outage flagged on disk');
  } finally {
    rt.restore();
    fetchStub.restore();
    clock.restore();
  }
});

test('alerts before exiting to recover, and still exits if Telegram is down', async () => {
  const clock = installFakeClock();
  const fetchStub = captureFetch({ reject: true });
  const rt = captureRuntime();
  clearFlag();
  try {
    const { mod, sockets } = loadModule({ reloadAlert: true });
    mod.connect();
    await flush();
    sockets[0].emit('connection.update', closeEvent(428));

    clock.tick(16 * 60 * 1000);
    await flush();

    assert.ok(
      fetchStub.texts().some((t) => /restarting to recover/i.test(t)),
      `expected a restart alert, got ${JSON.stringify(fetchStub.texts())}`
    );
    assert.deepStrictEqual(rt.exits, [1], 'a failed alert must not stop the restart');
  } finally {
    rt.restore();
    fetchStub.restore();
    clock.restore();
  }
});

test('a logout alerts loudly — a restart cannot fix it', async () => {
  const clock = installFakeClock();
  const fetchStub = captureFetch();
  const rt = captureRuntime();
  clearFlag();
  try {
    const { mod, sockets } = loadModule({ reloadAlert: true });
    mod.connect();
    await flush();
    sockets[0].emit('connection.update', { connection: 'open' });
    sockets[0].emit('connection.update', closeEvent(401));
    await flush();

    const text = fetchStub.texts().find((t) => /LOGGED OUT/.test(t));
    assert.ok(text, `expected a logout alert, got ${JSON.stringify(fetchStub.texts())}`);
    assert.match(text, /re-link/i, 'tells him what it actually needs');
  } finally {
    rt.restore();
    fetchStub.restore();
    clock.restore();
  }
});

test('reports recovery even when it happened via a process restart', async () => {
  const clock = installFakeClock();
  const fetchStub = captureFetch();
  const rt = captureRuntime();
  clearFlag();
  try {
    // Process #1 goes down and records the outage, then dies.
    const first = loadModule({ reloadAlert: true });
    first.mod.connect();
    await flush();
    first.sockets[0].emit('connection.update', closeEvent(428));
    clock.tick(6 * 60 * 1000);
    await flush();
    assert.strictEqual(fetchStub.calls.length, 1, 'outage alerted once');

    // Process #2 boots fresh — no in-memory knowledge of the outage at all.
    const second = loadModule({ reloadAlert: true });
    second.mod.connect();
    await flush();
    second.sockets[0].emit('connection.update', { connection: 'open' });
    await flush();

    assert.ok(
      fetchStub.texts().some((t) => /back online/i.test(t)),
      `expected a recovery alert, got ${JSON.stringify(fetchStub.texts())}`
    );
    assert.strictEqual(freshAlert().outageInfo(), null, 'flag cleared so it only reports once');
  } finally {
    rt.restore();
    fetchStub.restore();
    clock.restore();
  }
});

test('a normal connect does not claim a recovery', async () => {
  const clock = installFakeClock();
  const fetchStub = captureFetch();
  const rt = captureRuntime();
  clearFlag();
  try {
    const { mod, sockets } = loadModule({ reloadAlert: true });
    mod.connect();
    await flush();
    sockets[0].emit('connection.update', { connection: 'open' });
    await flush();
    assert.strictEqual(fetchStub.calls.length, 0, 'a clean boot is not an event worth pinging about');
  } finally {
    rt.restore();
    fetchStub.restore();
    clock.restore();
  }
});
