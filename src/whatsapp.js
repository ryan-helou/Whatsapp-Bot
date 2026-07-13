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

          if (loggedOut) {
            console.error(
              '✗ Logged out. Delete the /auth folder and re-run to link again.'
            );
            if (!resolved) {
              resolved = true;
              reject(new Error('logged out'));
            }
            return;
          }

          console.log('Connection closed, reconnecting…');
          start(); // reconnect with the same persisted auth
        }
      });
    };

    start();
  });
}

module.exports = { connect, AUTH_DIR };
