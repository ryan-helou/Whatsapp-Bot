#!/usr/bin/env node
// One-time linking: shows a QR code, then stays connected so you can confirm
// the session sticks. Auth is saved to /auth so you won't re-scan next time.
// Run: npm run link

const { connect } = require('../src/whatsapp');

(async () => {
  await connect();
  console.log('\nLinked. Session saved to /auth — you can Ctrl+C now.');
  console.log('(Leaving it running is fine too.)');
})().catch((err) => {
  console.error('Failed to link:', err.message);
  process.exit(1);
});
