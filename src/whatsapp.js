// Core WhatsApp connection module (Baileys).
// Handles: persisted auth (scan QR once), auto-reconnect, and a "ready" callback.

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

// Silence Baileys' internal logging; we do our own concise logging.
const logger = pino({ level: 'silent' });

/**
 * Connect to WhatsApp. Resolves with the live socket once the connection opens.
 * Automatically reconnects on transient drops. If the session is logged out
 * (e.g. you removed the linked device), it stops and tells you to re-link.
 *
 * @param {(sock) => void} [onReady] called every time the connection (re)opens.
 * @returns {Promise<object>} the Baileys socket
 */
async function connect(onReady) {
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

    const start = () => {
      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ['WhatsApp Scheduler', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false, // don't flip your phone to "offline"
      });

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
        const { connection, lastDisconnect, qr } = update;

        // Only draw a QR when we're NOT using pairing-code login.
        if (qr && !PAIRING_NUMBER) {
          console.log('\nScan this QR code in WhatsApp > Settings > Linked Devices:\n');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          console.log('✓ Connected to WhatsApp.');
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

          // A "logged out" (401) is only truly fatal AFTER the device was linked.
          // While still pairing (not yet registered), WhatsApp routinely closes
          // the socket with a 401 between handshake steps — that is NOT a real
          // logout. If we exited here, the host (Railway) would restart us and
          // mint a brand-new pairing code every few seconds, so you'd never be
          // able to enter one. Instead we stay alive, reconnect with the same
          // persisted auth, and keep the SAME pairing code valid.
          if (loggedOut && registered) {
            console.error('✗ Logged out (device was unlinked). Re-link required.');
            if (!resolved) {
              resolved = true;
              reject(new Error('logged out'));
            }
            return;
          }

          if (!registered && PAIRING_NUMBER) {
            console.log('Waiting for pairing-code entry… (reconnecting; the code stays the same)');
          } else {
            console.log('Connection closed, reconnecting…');
          }
          setTimeout(start, 3000); // reconnect with the same persisted auth
        }
      });
    };

    start();
  });
}

module.exports = { connect, AUTH_DIR };
