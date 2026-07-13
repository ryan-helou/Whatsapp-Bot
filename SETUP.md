# Setup Guide — plug in credentials and go

Everything is already built. You need to supply **two credentials** and run a few
commands. Budget ~20 minutes the first time.

1. A **Google service-account key** (so the bot can read your Sheet).
2. Your **WhatsApp session** (scan a QR once).

---

## Step 1 — Create the Google Sheet

1. Make a new Google Sheet. Name the first tab **`Schedule`** (bottom-left tab).
2. Put these headers in row 1, columns A–H:

   | A | B | C | D | E | F | G | H |
   |---|---|---|---|---|---|---|---|
   | Group Name | Group ID | Message | Days | Time | Timezone | Media URL | Active |

3. Leave the data rows empty for now — you'll fill Group IDs in Step 4.
4. Copy the **Sheet ID** from the URL:
   `docs.google.com/spreadsheets/d/`**`THIS_LONG_ID`**`/edit`

### How the columns work
- **Group ID** — the group's JID, like `12036...@g.us` (you get these in Step 4).
- **Days** — `Daily`, `Weekdays`, `Weekends`, or a list: `Mon,Wed,Fri`.
- **Time** — `09:00` (24-hour) or `9:00 AM`.
- **Timezone** — e.g. `America/New_York`. Blank = your `DEFAULT_TIMEZONE`.
- **Media URL** — optional public link to an image/video/pdf. Blank = text only.
- **Active** — `yes` (or blank) to run; `no` to pause that row without deleting it.

---

## Step 2 — Create the Google service account (read access to the Sheet)

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library →** search **Google Sheets API →** click **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Give it any name, click through **Create and continue → Done**.
4. Open the new service account → **Keys → Add key → Create new key → JSON.**
   A `.json` file downloads.
5. Put that file here in the project as **`credentials/service-account.json`**:
   ```
   mkdir -p credentials
   mv ~/Downloads/your-key-file.json credentials/service-account.json
   ```
6. Open the JSON and copy the **`client_email`** value (looks like
   `something@your-project.iam.gserviceaccount.com`).
7. Back in your Google Sheet, click **Share**, paste that email, give it **Viewer**,
   and send. *(This is what lets the bot read your sheet.)*

---

## Step 3 — Fill in your `.env`

```
cp .env.example .env
```
Edit `.env` and set at least:
- `SHEET_ID=` the ID from Step 1.
- `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./credentials/service-account.json` (default is fine).
- `DEFAULT_TIMEZONE=` your timezone (e.g. `America/New_York`).

Verify the sheet connection (no WhatsApp needed):
```
npm run check-sheet
```
It will say it read the sheet (0 rows is expected until Step 4).

---

## Step 4 — Link WhatsApp and get your Group IDs

1. Link your number (shows a QR in the terminal):
   ```
   npm run link
   ```
   On your phone: **WhatsApp → Settings → Linked Devices → Link a device →** scan.
   You'll see `✓ Connected`. Press Ctrl+C. The session is saved to `auth/`.

   > On a headless VPS, just run this over SSH — the QR draws as text in your
   > terminal and scans fine.

2. List your groups to get their IDs:
   ```
   npm run list-groups
   ```
   Copy each **Group ID** into column **B** of your sheet, next to the right group.

3. Fill in Message / Days / Time / Timezone for each row. Then re-check:
   ```
   npm run check-sheet
   ```
   It prints each row and the **next time it will send** — confirm those look right.

---

## Step 5 — Dry run (preview without sending)

In `.env` set `DRY_RUN=true`, then:
```
npm start
```
When a row is due it prints `[DRY RUN] would send …` instead of sending. Once you're
happy, set `DRY_RUN=false`.

> Tip for an instant test: set one row's Time to 2 minutes from now and watch.

---

## Step 6 — Run it 24/7 on the VPS

### Option A — pm2 (simplest)
```
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup      # run the command it prints, so it restarts on reboot
```
Watch it: `pm2 logs whatsapp-scheduler`

### Option B — Docker
```
# first-time WhatsApp link inside the container:
docker compose run --rm whatsapp-scheduler node bin/link.js   # scan QR, Ctrl+C
# then run for real:
docker compose up -d
docker compose logs -f
```

---

## Everyday use
- **Change messages/schedule:** just edit the Google Sheet. The bot re-reads it every
  few minutes — no restart needed.
- **See what went out:** `npm run log` (or `pm2 logs`).
- **Pause a message:** set its **Active** cell to `no`.

---

## Step 7 — (Optional) Text a Telegram bot to control it in plain English

Instead of opening the sheet, you can text a Telegram bot things like *"swap Jacob
for John in the cleanup message"*, *"what's scheduled today?"*, or *"pause the Work
group"*, and it edits the sheet for you.

**This needs two extra credentials** and one permission change:

1. **Let the bot write to your sheet.** In Step 2 you shared the sheet with the
   service account as *Viewer*. Change that to **Editor** (Share → its email → Editor)
   so it can make edits.
2. **Create the Telegram bot.** In Telegram, message **@BotFather** → `/newbot` →
   follow prompts. It gives you a **token** like `1234:AbC...`. Put it in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=1234:AbC...
   ```
3. **Anthropic API key** (powers the natural-language understanding). Get one at
   <https://console.anthropic.com> → API keys. Add to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   Cost is tiny at this volume — a handful of edits a week is fractions of a cent.
4. **Lock it to you.** Start the bot (`npm start`), open Telegram, find your bot,
   and send it any message. It replies **"Not authorized. Your Telegram ID is
   123456789."** Copy that number into `.env` and restart:
   ```
   TELEGRAM_ALLOWED_USER_IDS=123456789
   ```
   Now only you can control it. (Add more IDs comma-separated if needed.)

Send `/start` to see examples. Every edit takes effect immediately (the bot refreshes
the schedule right after changing the sheet). Leave `TELEGRAM_BOT_TOKEN` blank to keep
this feature off entirely.

**What you can text it:**
- *"what's scheduled today?"* / *"show the cleanup message"*
- *"swap Jacob for John in the cleanup message"*
- *"change the Family morning message to Good morning all ☀️"*
- *"add a message to the Family group: Good morning ☀️ every day at 9am"* (creates a new row)
- *"pause the Work group"* / *"resume it"* (it remembers what you were talking about)
- *"delete the cleanup message"* (asks you to confirm first)
- *"send the cleanup message now"* (asks you to confirm, then sends immediately)

It looks up your real WhatsApp groups by name, so adding messages needs no group IDs.
Destructive/immediate actions (delete, send now) always ask for confirmation.

**Optional — daily summary DM.** To get a message each day listing what went out, set a
time in `.env` (in your `DEFAULT_TIMEZONE`):
```
DAILY_SUMMARY_TIME=21:00
```

---

## Step 8 — (Optional) Rotating reminders — replaces the old AttendanceW bot

This project absorbs the old **AttendanceW** reminder (whose turn it is to take
Saturday attendance) — no separate script/Green API/GitHub Actions needed.

Messages can contain **placeholders** that fill in when sent:
- `{rotation:attendance}` → the person assigned this week
- `{next_saturday}` → the upcoming Saturday (e.g. "March 21")
- `{today}` → today's date

The rotation is defined in [config/rotations.json](config/rotations.json) (already
pre-filled with `attendance` = Ryan → Jona → Aly → Holy → Julia, anchored to the
Monday of 2026-03-16). Edit that file to change members or order. Preview anytime:
```
npm run rotation
```

**To recreate AttendanceW,** add two rows to your Google Sheet for the attendance
group (paste its Group ID from `npm run list-groups`):

| Group Name | Group ID | Message | Days | Time | Timezone | Media | Active |
|---|---|---|---|---|---|---|---|
| Attendance | `…@g.us` | `{rotation:attendance} will be taking attendance on Saturday {next_saturday}. Please like this message to confirm 😁` | Mon | 12:00 | America/New_York | | yes |
| Attendance | `…@g.us` | `Don't forget that today {rotation:attendance} will be taking attendance!` | Sat | 12:00 | America/New_York | | yes |

`npm run check-sheet` will show the fully-rendered message (with the current name
filled in). This also fixes AttendanceW's daylight-saving drift — times are now
anchored to `America/New_York`, so noon stays noon year-round. Once these rows
are in and sending, you can retire the old AttendanceW repo/Actions.

You can also just ask the Telegram bot: *"who's taking attendance this week?"*

---

## Switching to a dedicated number later
Delete the `auth/` folder, run `npm run link`, and scan with the new number's phone.
Nothing else changes.

## If the number gets disconnected / logged out
Re-run `npm run link` and scan again. If WhatsApp shows a ban, that's the ToS risk we
discussed — switch to a dedicated number.
