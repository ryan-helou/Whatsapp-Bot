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

// "Aly" or, when someone is shadowing, "Aly (with Maykel shadowing)".
function formatAssignment(lead, shadow) {
  return shadow ? `${lead} (with ${shadow} shadowing)` : lead;
}

// An override entry may be a bare name ("Ryan") or { lead, shadow? }.
function normalizeOverride(value, fallbackLead) {
  if (typeof value === 'string') return formatAssignment(value, null);
  if (value && typeof value === 'object') {
    const lead = value.lead || fallbackLead || '';
    return formatAssignment(lead, value.shadow || null);
  }
  return null;
}

// Who is assigned for the week containing `now` (a luxon DateTime)?
// Returns the display string (e.g. "Anthony" or, during a shadow week,
// "Anthony (with Maykel shadowing)"), or null if the rotation is unknown.
//
// Resolution order:
//   1. `overrides` — a { date: lead | {lead, shadow} } map for one-off changes
//      ("Julia is away, push her a week"). Any date inside the target week
//      matches, so you don't have to work out which Monday it was.
//   2. `sequence` — an explicit list of { lead, shadow? } for the first N weeks
//      (used for a learning/shadowing phase).
//   3. a plain modular rotation over `members`, with the week index continuing
//      from where the sequence left off.
function currentMember(name, now) {
  const r = defs[String(name || '').trim().toLowerCase()];
  if (!r) return null;
  const tz = r.timezone || now.zoneName;
  const anchor = DateTime.fromISO(r.anchor, { zone: tz }).startOf('day');
  const today = now.setZone(tz).startOf('day');
  const weekOf = (d) => Math.floor(Math.floor(d.diff(anchor, 'days').days) / 7);
  const wk = weekOf(today);

  const seq = Array.isArray(r.sequence) ? r.sequence : [];

  // 1. One-off overrides win over everything else. Matching on week INDEX (not
  // the literal date string) means any day within that week is a valid key.
  if (r.overrides && typeof r.overrides === 'object') {
    for (const [key, value] of Object.entries(r.overrides)) {
      const d = DateTime.fromISO(key, { zone: tz });
      if (!d.isValid) {
        console.error(`Rotation "${r.name}": ignoring invalid override date "${key}"`);
        continue;
      }
      if (weekOf(d.startOf('day')) === wk) {
        const resolved = normalizeOverride(value, r.members && r.members[0]);
        if (resolved) return resolved;
      }
    }
  }

  // 2. The explicit opening sequence, if this week falls inside it.
  if (wk >= 0 && wk < seq.length) {
    const s = seq[wk] || {};
    const lead = s.lead || (r.members && r.members[0]) || '';
    return formatAssignment(lead, s.shadow || null);
  }

  // 3. Steady-state modular rotation.
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
