// Reads the schedule from a Google Sheet using a service account (read-only).
// Returns parsed + validated entries.

const { google } = require('googleapis');
const { parseRow } = require('./schedule');
const { authOptions } = require('./googleAuth');

let sheetsClient = null;

async function getSheetsClient(config) {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    ...authOptions(config),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

/**
 * Fetch and parse all schedule rows. Returns { entries, valid, invalid }.
 * `entries` includes every non-empty row (valid or not) so callers can report
 * problems; `valid` is the subset that will actually be scheduled.
 */
async function loadSchedule(config) {
  if (!config.sheetId) {
    throw new Error('SHEET_ID is not set. Add it to your .env.');
  }
  const sheets = await getSheetsClient(config);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: config.sheetRange,
  });

  const rows = res.data.values || [];
  const entries = [];
  rows.forEach((cells, i) => {
    // Skip fully-empty rows.
    if (!cells || cells.every((c) => String(c || '').trim() === '')) return;
    // Row number in the actual sheet: range starts at row 2 (header is row 1).
    const rowNumber = i + 2;
    entries.push(parseRow(cells, rowNumber, config.defaultTimezone));
  });

  const valid = entries.filter((e) => e.valid);
  const invalid = entries.filter((e) => !e.valid);
  return { entries, valid, invalid };
}

module.exports = { loadSchedule };
