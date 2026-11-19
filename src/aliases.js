// Display-name fixes for chat logs.
//
// WhatsApp shows whatever someone set as their push name — "alex the great🔥",
// "dee😎". In a log meant to be read (by a person or an AI) those are noise at
// best and unidentifiable at worst, so map them to real names.
//
// Replacement happens in message TEXT as well as in the sender field: these
// names appear in @mentions ("Backups: @alex the great🔥") and in system lines
// ("bee🐝 created this group"), and a log that renames the speaker but not
// the mentions reads as two different people.

const fs = require('fs');

let pairs = []; // [from, to], longest `from` first

function load(file) {
  pairs = [];
  try {
    if (!file || !fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = parsed && parsed.aliases ? parsed.aliases : parsed;
    for (const [from, to] of Object.entries(map || {})) {
      if (from.startsWith('_')) continue; // comment keys
      if (typeof to === 'string' && from) pairs.push([from, to]);
    }
    // Longest first, so a name that contains another is handled before it.
    pairs.sort((a, b) => b[0].length - a[0].length);
  } catch (err) {
    console.error('Could not load name aliases:', err.message);
    pairs = [];
  }
}

function apply(value) {
  if (!value) return value;
  let out = String(value);
  for (const [from, to] of pairs) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

const count = () => pairs.length;
const list = () => pairs.map(([from, to]) => ({ from, to }));

module.exports = { load, apply, count, list };
