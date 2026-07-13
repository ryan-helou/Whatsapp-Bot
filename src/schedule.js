// Parses raw sheet rows into schedule entries and decides when they are "due".
// Timezone-aware via luxon.

const { DateTime } = require('luxon');

const WEEKDAYS = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

// Parse the Days cell into a Set of luxon weekday numbers (1=Mon..7=Sun).
function parseDays(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return { days: null, error: 'Days is empty' };
  if (s === 'daily' || s === 'everyday' || s === 'every day' || s === 'all') {
    return { days: new Set([1, 2, 3, 4, 5, 6, 7]) };
  }
  if (s === 'weekdays') return { days: new Set([1, 2, 3, 4, 5]) };
  if (s === 'weekends') return { days: new Set([6, 7]) };

  const parts = s.split(/[,/|]+/).map((p) => p.trim()).filter(Boolean);
  const days = new Set();
  for (const p of parts) {
    const n = WEEKDAYS[p];
    if (!n) return { days: null, error: `Unrecognized day: "${p}"` };
    days.add(n);
  }
  if (days.size === 0) return { days: null, error: 'No valid days' };
  return { days };
}

// Parse "HH:MM" (24h), tolerating "9:00", "9:00 AM", "9 pm".
function parseTime(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return { time: null, error: 'Time is empty' };
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return { time: null, error: `Bad time format: "${raw}" (use HH:MM)` };
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (ampm) {
    if (hour < 1 || hour > 12) return { time: null, error: `Bad hour: "${raw}"` };
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { time: null, error: `Time out of range: "${raw}"` };
  }
  return { time: { hour, minute } };
}

function parseActive(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  // Blank counts as active; only explicit off values pause the row.
  return !/^(no|false|0|off|paused|inactive)$/.test(s);
}

/**
 * Turn one raw sheet row (array of cells) into a parsed entry.
 * Columns: A GroupName | B GroupID | C Message | D Days | E Time | F Timezone | G MediaURL | H Active
 */
function parseRow(cells, rowNumber, defaultTimezone) {
  const [groupName, jid, message, daysRaw, timeRaw, tzRaw, mediaUrl, activeRaw] = cells;
  const errors = [];

  const active = parseActive(activeRaw);
  const timezone = String(tzRaw || '').trim() || defaultTimezone;

  if (!String(jid || '').trim()) errors.push('Missing Group ID');
  else if (!/@g\.us$/.test(String(jid).trim())) {
    errors.push(`Group ID doesn't look like a group JID (should end in @g.us): "${jid}"`);
  }
  if (!String(message || '').trim() && !String(mediaUrl || '').trim()) {
    errors.push('Row has neither a Message nor a Media URL');
  }
  if (!DateTime.local().setZone(timezone).isValid) {
    errors.push(`Invalid timezone: "${timezone}"`);
  }

  const { days, error: daysErr } = parseDays(daysRaw);
  if (daysErr) errors.push(daysErr);
  const { time, error: timeErr } = parseTime(timeRaw);
  if (timeErr) errors.push(timeErr);

  return {
    rowNumber,
    groupName: String(groupName || '').trim() || '(unnamed)',
    jid: String(jid || '').trim(),
    message: String(message || '').trim(),
    mediaUrl: String(mediaUrl || '').trim(),
    days,
    time,
    timezone,
    active,
    errors,
    valid: errors.length === 0,
  };
}

// Stable id used for dedupe: "row-<n>-<YYYY-MM-DD in the row's timezone>".
function dedupeKey(entry, now) {
  const local = now.setZone(entry.timezone);
  return `row-${entry.rowNumber}-${local.toFormat('yyyy-LL-dd')}`;
}

/**
 * Is this entry due to send right now?
 * Due when: active, today's weekday matches, and we're at/after the scheduled
 * time but no later than the catch-up grace window (handles the bot being
 * briefly offline without firing hours-late messages).
 */
function isDue(entry, now, graceMinutes) {
  if (!entry.valid || !entry.active) return { due: false };
  const local = now.setZone(entry.timezone);
  if (!entry.days.has(local.weekday)) return { due: false };

  const scheduled = local.set({
    hour: entry.time.hour,
    minute: entry.time.minute,
    second: 0,
    millisecond: 0,
  });
  const diffMin = local.diff(scheduled, 'minutes').minutes;
  const due = diffMin >= 0 && diffMin <= graceMinutes;
  return { due, scheduled, diffMin };
}

// Next scheduled run at/after `now`, for display in check-sheet.
function nextRun(entry, now) {
  if (!entry.valid) return null;
  let local = now.setZone(entry.timezone);
  for (let i = 0; i < 8; i++) {
    const day = local.plus({ days: i });
    if (!entry.days.has(day.weekday)) continue;
    const candidate = day.set({
      hour: entry.time.hour,
      minute: entry.time.minute,
      second: 0,
      millisecond: 0,
    });
    if (candidate >= now.setZone(entry.timezone)) return candidate;
  }
  return null;
}

module.exports = { parseRow, isDue, nextRun, dedupeKey, parseDays, parseTime };
