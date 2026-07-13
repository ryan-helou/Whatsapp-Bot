#!/usr/bin/env node
// Sends a one-off test message to a group, to prove sending works end-to-end.
// Usage: node bin/send-test.js "<group-jid>" "<message>"
// Example: node bin/send-test.js "12036...@g.us" "Hello from the bot 👋"

const { connect } = require('../src/whatsapp');

const [, , jid, ...messageParts] = process.argv;
const message = messageParts.join(' ');

if (!jid || !message) {
  console.error('Usage: node bin/send-test.js "<group-jid>" "<message>"');
  process.exit(1);
}

(async () => {
  const sock = await connect();
  await new Promise((r) => setTimeout(r, 2000)); // let the socket settle

  await sock.sendMessage(jid, { text: message });
  console.log(`✓ Sent to ${jid}: "${message}"`);

  await new Promise((r) => setTimeout(r, 1500)); // let delivery flush
  process.exit(0);
})().catch((err) => {
  console.error('Failed to send:', err.message);
  process.exit(1);
});
