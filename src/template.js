// Renders dynamic placeholders in a message at send time. Supported:
//   {rotation:NAME}   -> this week's assigned member of rotation NAME
//   {next_saturday}   -> the upcoming Saturday, e.g. "March 21"
//   {next_saturday:FORMAT} -> same, custom luxon format (e.g. {next_saturday:LLL d})
//   {today}           -> today's date, e.g. "March 16"
// Unknown placeholders are left untouched (and reported in errors).

const rotations = require('./rotations');

function nextWeekday(now, targetWeekday) {
  // luxon weekday: Mon=1 .. Sun=7
  const delta = (targetWeekday - now.weekday + 7) % 7;
  return now.plus({ days: delta });
}

// Render against a luxon DateTime `now` (already set to the message's timezone).
function render(text, now) {
  const errors = [];
  let out = String(text || '');

  out = out.replace(/\{rotation:([^}]+)\}/g, (_, name) => {
    const person = rotations.currentMember(name.trim(), now);
    if (person === null) {
      errors.push(`unknown rotation "${name.trim()}"`);
      return `{rotation:${name}}`;
    }
    return person;
  });

  out = out.replace(/\{next_saturday(?::([^}]+))?\}/g, (_, fmt) =>
    nextWeekday(now, 6).toFormat(fmt || 'LLLL d')
  );

  out = out.replace(/\{today(?::([^}]+))?\}/g, (_, fmt) => now.toFormat(fmt || 'LLLL d'));

  return { text: out, errors };
}

// Return a copy of a schedule entry with its message rendered for `now`.
function renderEntry(entry, now) {
  const localNow = now.setZone(entry.timezone || now.zoneName);
  const { text, errors } = render(entry.message, localNow);
  return { ...entry, message: text, renderErrors: errors };
}

module.exports = { render, renderEntry };
