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
// Returns the display string (e.g. "Anthony" or, during a shadow week,
// "Anthony (with Maykel shadowing)"), or null if the rotation is unknown.
//
// A rotation may optionally define a `sequence`: an explicit list of
// { lead, shadow? } for the first N weeks (used for a learning/shadowing
// phase). After the sequence is exhausted, it falls back to a plain modular
// rotation over `members`, with the week index continuing from where the
// sequence left off.
function currentMember(name, now) {
  const r = defs[String(name || '').trim().toLowerCase()];
  if (!r) return null;
  const tz = r.timezone || now.zoneName;
  const anchor = DateTime.fromISO(r.anchor, { zone: tz }).startOf('day');
  const today = now.setZone(tz).startOf('day');
  const diffDays = Math.floor(today.diff(anchor, 'days').days);
  const wk = Math.floor(diffDays / 7);

  const seq = Array.isArray(r.sequence) ? r.sequence : [];
  if (wk >= 0 && wk < seq.length) {
    const s = seq[wk] || {};
    const lead = s.lead || (r.members && r.members[0]) || '';
    return s.shadow ? `${lead} (with ${s.shadow} shadowing)` : lead;
  }

  const n = r.members.length;
  if (!n) return '';
  let idx = (wk - seq.length) % n;
  idx = ((idx % n) + n) % n; // keep positive for dates before the anchor
  return r.members[idx];
}

function list() {
  return Object.values(defs);
}

module.exports = { load, currentMember, list };
