// Weekly rotations (e.g. "whose turn is it to take attendance this week").
// Definitions live in a JSON file; each is { name, members[], anchor (a Monday),
// timezone? }. The week is computed the same way the original AttendanceW script
// did: full weeks since the anchor date, modulo the number of members.

const fs = require('fs');
const { DateTime } = require('luxon');

let defs = {}; // lowercased name -> definition

function load(file) {
  try {
    if (!fs.existsSync(file)) {
      defs = {};
      return;
    }
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    defs = {};
    for (const r of arr || []) {
      if (r && r.name && Array.isArray(r.members) && r.members.length && r.anchor) {
        defs[String(r.name).toLowerCase()] = r;
      }
    }
  } catch (err) {
    console.error('Could not load rotations:', err.message);
    defs = {};
  }
}

// Who is assigned for the week containing `now` (a luxon DateTime)?
// Returns the member name, or null if the rotation is unknown.
function currentMember(name, now) {
  const r = defs[String(name || '').trim().toLowerCase()];
  if (!r) return null;
  const tz = r.timezone || now.zoneName;
  const anchor = DateTime.fromISO(r.anchor, { zone: tz }).startOf('day');
  const today = now.setZone(tz).startOf('day');
  const diffDays = Math.floor(today.diff(anchor, 'days').days);
  const n = r.members.length;
  let idx = Math.floor(diffDays / 7) % n;
  idx = ((idx % n) + n) % n; // keep positive for dates before the anchor
  return r.members[idx];
}

function list() {
  return Object.values(defs);
}

module.exports = { load, currentMember, list };
