#!/usr/bin/env node
// Links WhatsApp by rendering the QR as a crisp PNG image (opened in Preview),
// which is far easier to scan than a terminal/ASCII QR. Session saves to the
// dir given by AUTH_DIR. Run: AUTH_DIR=... node bin/link-qr-image.js

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const { execFile } = require('child_process');

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, '..', 'auth');
const OUT = path.join(__dirname, '..', 'data', 'wa-qr.png');
const logger = pino({ level: 'silent' });

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const start = () => {
    const sock = makeWASocket({ version, auth: state, logger, browser: ['WhatsApp Scheduler', 'Chrome', '1.0.0'], markOnlineOnConnect: false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        // Big, high-error-correction PNG for easy scanning.
        await QRCode.toFile(OUT, qr, { width: 600, margin: 2, errorCorrectionLevel: 'M' });
        console.log('QR_IMAGE_READY ' + OUT);
        execFile('open', [OUT], () => {}); // pop it open in Preview
      }
      if (connection === 'open') {
        console.log('CONNECTED_OK');
        process.exit(0);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) { console.log('LOGGED_OUT'); process.exit(1); }
        start();
      }
    });
  };
  start();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
