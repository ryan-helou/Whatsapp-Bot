// Core WhatsApp connection module (Baileys).
// Handles: persisted auth (scan QR once), auto-reconnect with backoff, a "ready"
// callback, and a watchdog that exits the process if we stay offline — so the
// host (Railway/pm2/Docker) restarts us instead of leaving a live process with a
// dead socket.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Auth location is configurable so a cloud host can point it at a persistent
// volume (e.g. AUTH_DIR=/data/auth) — otherwise the session is wiped on every
// redeploy and you'd have to re-link each time.
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, '..', 'auth');

// If set (full number incl. country code, digits only, e.g. 15145551234), link
// via an 8-character pairing code printed to the logs instead of a QR code.
// This is the reliable way to link on a headless/cloud host where you can't
// scan a QR out of the log viewer.
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, '');

const numEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Reconnect backoff. A fixed short retry hammers WhatsApp for hours during an
// outage (and looks like abuse); back off instead, capped so we still recover
// promptly once the far end is healthy again.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = numEnv('RECONNECT_MAX_SECONDS', 300) * 1000;

// If we can't hold an open connection for this long, exit non-zero so the host
// restarts the whole process with a clean socket + fresh auth bootstrap. This is
// the backstop for the failure mode where the reconnect chain dies silently and
// the process lingers forever with a socket that can never send.
const OFFLINE_EXIT_MS = numEnv('OFFLINE_EXIT_MINUTES', 15) * 60 * 1000;

// Silence Baileys' internal logging; we do our own concise logging.
const logger = pino({ level: 'silent' });

/**
 * Connect to WhatsApp. Resolves with the live socket once the connection opens.
 * Automatically reconnects on transient drops. If the session is logged out
 * (e.g. you removed the linked device), it stops and tells you to re-link.
 *
 * @param {(sock) => void} [onReady] called every time the connection (re)opens.
 * @param {() => void} [onLost] called whenever the connection drops, so callers
 *        can stop using the (now dead) socket until onReady fires again.
 * @returns {Promise<object>} the Baileys socket
 */
async function connect(onReady, onLost) {
  // Cloud bootstrap: if a base64-encoded creds blob is provided and no session
  // exists yet on disk, materialize creds.json so we come up as an ALREADY
  // linked device — no QR scan or pairing code needed on a headless host. The
  // rest of the session state (app-state keys, pre-keys) re-syncs on connect.
  const credsB64 = (process.env.WA_CREDS_B64 || '').trim();
  if (credsB64) {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      fs.writeFileSync(credsPath, Buffer.from(credsB64, 'base64').toString('utf8'));
      console.log('✓ Restored WhatsApp session from WA_CREDS_B64.');
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    let resolved = false;
    let pairingRequested = false;

    // Reconnect bookkeeping.
    let attempts = 0; // consecutive failures since the last successful open
    let restartPending = false; // guards against two reconnect chains running
    let generation = 0; // only the newest socket may drive the chain
    let offlineSince = Date.now(); // null while the connection is open

    // Watchdog: the whole point is that a stuck/dead connection must not be
    // survivable. If we're offline past the threshold, take the process down.
    const watchdog = setInterval(() => {
      if (offlineSince === null) return;
      const downMs = Date.now() - offlineSince;
      if (downMs >= OFFLINE_EXIT_MS) {
        console.error(
          `✗ WhatsApp offline for ${Math.round(downMs / 60000)} min — exiting so the ` +
            'host restarts with a clean session.'
        );
        clearInterval(watchdog);
        process.exit(1);
      }
    }, 30000);
    if (watchdog.unref) watchdog.unref();

    const markOffline = () => {
      if (offlineSince === null) offlineSince = Date.now();
      if (onLost) {
        try {
          onLost();
        } catch (_) {
          /* never let a callback kill the reconnect chain */
        }
      }
    };

    const scheduleRestart = () => {
      if (restartPending) return;
      restartPending = true;
      attempts += 1;
      const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
      const delay = backoff + Math.floor(Math.random() * 1000);
      console.log(`Connection closed, reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts})…`);
      setTimeout(() => {
        restartPending = false;
        start();
      }, delay);
    };

    const start = () => {
      generation += 1;
      const myGeneration = generation;
      let sock;

      // If socket construction itself throws, the chain must still continue —
      // otherwise we'd be left alive with no connection and no retry.
      try {
        sock = makeWASocket({
          version,
          auth: state,
          logger,
          browser: ['WhatsApp Scheduler', 'Chrome', '1.0.0'],
          syncFullHistory: false,
          markOnlineOnConnect: false, // don't flip your phone to "offline"
        });
      } catch (err) {
        console.error('Could not open WhatsApp socket:', err.message);
        markOffline();
        scheduleRestart();
        return;
      }

      sock.ev.on('creds.update', saveCreds);

      // Headless pairing-code login: if a number is configured and we're not yet
      // linked, request a code once and print it. (Ignored once already linked.)
      if (PAIRING_NUMBER && !sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true;
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(PAIRING_NUMBER);
            console.log(
              `\n🔑 Pairing code: ${code}\n` +
                '   On your phone: WhatsApp > Settings > Linked Devices > Link a Device >\n' +
                '   "Link with phone number instead" > enter this code.\n'
            );
          } catch (e) {
            console.error('Could not request pairing code:', e.message);
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        // Ignore stragglers from a superseded socket: they must not schedule a
        // reconnect (two chains = two sockets fighting over the same session).
        if (myGeneration !== generation) return;

        const { connection, lastDisconnect, qr } = update;

        // Only draw a QR when we're NOT using pairing-code login.
        if (qr && !PAIRING_NUMBER) {
          console.log('\nScan this QR code in WhatsApp > Settings > Linked Devices:\n');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          console.log('✓ Connected to WhatsApp.');
          attempts = 0;
          offlineSince = null;
          if (onReady) onReady(sock);
          if (!resolved) {
            resolved = true;
            resolve(sock);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          const registered = !!sock.authState?.creds?.registered;

          markOffline();

          // Drop this socket's listeners so it can't drive the chain any more.
          try {
            sock.ev.removeAllListeners('connection.update');
          } catch (_) {
            /* best effort */
          }

          // A "logged out" (401) is only truly fatal AFTER the device was linked.
          // While still pairing (not yet registered), WhatsApp routinely closes
          // the socket with a 401 between handshake steps — that is NOT a real
          // logout. If we exited here, the host (Railway) would restart us and
          // mint a brand-new pairing code every few seconds, so you'd never be
          // able to enter one. Instead we stay alive, reconnect with the same
          // persisted auth, and keep the SAME pairing code valid.
          if (loggedOut && registered) {
            console.error(
              '✗ Logged out (device was unlinked). RE-LINK REQUIRED: run `npm run link`, ' +
                'then update WA_CREDS_B64.'
            );
            if (!resolved) {
              resolved = true;
              reject(new Error('logged out'));
              return;
            }
            // Already running: don't sit here as a live process that can never
            // send. Exit (after a pause, so we don't hammer WhatsApp in a tight
            // crash-loop) and let the host restart us.
            setTimeout(() => process.exit(1), 60000);
            return;
          }

          scheduleRestart();
        }
      });
    };

    start();
  });
}

module.exports = { connect, AUTH_DIR };
