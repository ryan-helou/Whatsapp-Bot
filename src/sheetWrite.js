// Read + WRITE access to the Google Sheet, used by the Telegram control bot.
// (The scheduler itself uses the read-only src/sheet.js.) Requires the service
// account to have EDITOR access to the sheet.

const { google } = require('googleapis');
const { authOptions } = require('./googleAuth');

const COL = { groupName: 'A', jid: 'B', message: 'C', days: 'D', time: 'E', tz: 'F', media: 'G', active: 'H' };

let client = null;

async function getClient(config) {
  if (client) return client;
  const auth = new google.auth.GoogleAuth({
    ...authOptions(config),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], // read + write
  });
  client = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return client;
}

function tabName(config) {
  return config.sheetRange.split('!')[0] || 'Schedule';
}

// Read all non-empty rows as friendly objects (row number included).
async function readRows(config) {
  const sheets = await getClient(config);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: config.sheetRange,
  });
  const rows = res.data.values || [];
  const out = [];
  rows.forEach((c, i) => {
    if (!c || c.every((x) => String(x || '').trim() === '')) return;
    out.push({
      row: i + 2,
      groupName: c[0] || '',
      jid: c[1] || '',
      message: c[2] || '',
      days: c[3] || '',
      time: c[4] || '',
      timezone: c[5] || '',
      mediaUrl: c[6] || '',
      active: !/^(no|false|0|off|paused|inactive)$/i.test(String(c[7] ?? '').trim()),
    });
  });
  return out;
}

async function setCell(config, col, row, value) {
  const sheets = await getClient(config);
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: `${tabName(config)}!${col}${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

// Set the Message cell of a row.
async function updateMessage(config, row, message) {
  await setCell(config, COL.message, row, message);
  return { row, message };
}

// Set the Active cell (true/false) of a row.
async function setActive(config, row, active) {
  await setCell(config, COL.active, row, active ? 'yes' : 'no');
  return { row, active };
}

// Literal find/replace inside Message cells. Optional groupName filter (case-
// insensitive substring). Returns the rows that actually changed, with before/after.
async function replaceText(config, find, replace, groupName) {
  const rows = await readRows(config);
  const changed = [];
  for (const r of rows) {
    if (groupName && !r.groupName.toLowerCase().includes(groupName.toLowerCase())) continue;
    if (!r.message.includes(find)) continue;
    const before = r.message;
    const after = before.split(find).join(replace);
    if (after === before) continue;
    await setCell(config, COL.message, r.row, after);
    changed.push({ row: r.row, groupName: r.groupName, before, after });
  }
  return changed;
}

// Append a brand-new scheduled message row (columns A–H).
async function appendRow(config, { groupName, jid, message, days, time, timezone, mediaUrl }) {
  const sheets = await getClient(config);
  const values = [[
    groupName || '',
    jid || '',
    message || '',
    days || '',
    time || '',
    timezone || '',
    mediaUrl || '',
    'yes',
  ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${tabName(config)}!A:H`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return { groupName, message, days, time };
}

// Remove a scheduled message by blanking its row (the reader skips empty rows).
async function clearRow(config, row) {
  const sheets = await getClient(config);
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.sheetId,
    range: `${tabName(config)}!A${row}:H${row}`,
  });
  return { row, cleared: true };
}

module.exports = { readRows, updateMessage, setActive, replaceText, appendRow, clearRow };
