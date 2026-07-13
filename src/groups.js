// A directory of the WhatsApp groups the linked account is in (name → JID).
// Populated when WhatsApp connects, and persisted so it survives restarts.
// Lets the Telegram agent add messages to a group by NAME without you having
// to paste JIDs.

const fs = require('fs');
const path = require('path');

let groups = []; // [{ jid, name, size }]
let file = null;

function load(dataDir) {
  file = path.join(dataDir, 'groups.json');
  try {
    if (fs.existsSync(file)) groups = JSON.parse(fs.readFileSync(file, 'utf8')) || [];
  } catch (err) {
    console.error('Could not read groups cache:', err.message);
    groups = [];
  }
}

function save() {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(groups, null, 2));
  } catch (err) {
    console.error('Could not save groups cache:', err.message);
  }
}

// Refresh from a live Baileys socket.
async function refreshFromSock(sock) {
  try {
    const map = await sock.groupFetchAllParticipating();
    groups = Object.values(map)
      .map((g) => ({ jid: g.id, name: g.subject || '(unnamed)', size: g.participants?.length ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    save();
    console.log(`✓ Group directory refreshed (${groups.length} groups).`);
  } catch (err) {
    console.error('Could not refresh group directory:', err.message);
  }
}

function all() {
  return groups.slice();
}

// Resolve a user-typed group name to a group. Returns:
//   { match } on a single confident match,
//   { matches } when several groups match (ambiguous — caller should ask),
//   { none: true } when nothing matches.
function resolve(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return { none: true };
  const exact = groups.filter((g) => g.name.toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0] };
  const partial = groups.filter((g) => g.name.toLowerCase().includes(q));
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length > 1) return { matches: partial };
  return { none: true };
}

module.exports = { load, save, refreshFromSock, all, resolve };
