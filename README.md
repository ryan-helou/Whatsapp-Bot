# WhatsApp Scheduled Group Bot

Sends scheduled, recurring messages (different content per group) to your existing
WhatsApp groups. Messages and schedule live in a **Google Sheet** you can edit anytime.
Runs 24/7 on a small server.

- **Connection:** [Baileys](https://github.com/WhiskeySockets/Baileys) (links as a companion device — scan a QR once).
- **Source of truth:** a Google Sheet (read via a Google service account).
- **Scheduling:** timezone-aware, recurring daily/weekly, with catch-up + dedupe.
- **Anti-ban:** human-like timing (typing presence, randomized jitter, spaced sends).
- **Rotating reminders (absorbs the old AttendanceW bot):** message placeholders like `{rotation:attendance}` and `{next_saturday}` resolve at send time — whose turn it is this week, the upcoming Saturday. Rotations in [config/rotations.json](config/rotations.json); preview with `npm run rotation`.
- **Optional Telegram control:** text a bot in plain English to view, edit, add, delete, or immediately send scheduled messages ("swap Jacob for John in the cleanup message", "add a 9am good-morning to the Family group", "send the cleanup message now") — powered by Claude (`claude-opus-4-8`), with conversation memory and confirmations for destructive actions. Optional daily summary DM of what went out.

> ⚠️ Automating a personal WhatsApp number is against WhatsApp's Terms of Service and
> carries some ban risk. At this volume (a handful of your own groups, a few messages a
> week) it's low, and the design minimizes it — but it can't be eliminated. You can swap
> to a dedicated number anytime by re-linking.

## Quick start
Full walkthrough in **[SETUP.md](SETUP.md)**. In short:
```
npm install
cp .env.example .env          # set SHEET_ID, timezone
# add credentials/service-account.json and share the Sheet with it (see SETUP.md)
npm run link                  # scan the QR once
npm run list-groups           # get group IDs → paste into the Sheet
npm run check-sheet           # verify rows + next send times
npm start                     # run (use pm2/Docker for 24/7 — see SETUP.md)
```

## Commands
| Command | What it does |
|---|---|
| `npm run link` | Link WhatsApp (QR). Session saved to `auth/`. |
| `npm run list-groups` | List your groups + their IDs. |
| `npm run check-sheet` | Validate the Sheet, show next send times. No WhatsApp needed. |
| `npm run send-test "<jid>" "<msg>"` | Send a one-off test message. |
| `npm run log` | Show recent send attempts (ok/failed). |
| `npm start` | Run the scheduler service. |

## The Google Sheet
Tab **`Schedule`**, columns A–H:

| Group Name | Group ID | Message | Days | Time | Timezone | Media URL | Active |
|---|---|---|---|---|---|---|---|
| Family | `1203…@g.us` | Good morning ☀️ | Daily | 09:00 | America/New_York | | yes |
| Work | `9821…@g.us` | Standup in 15 | Mon,Tue,Wed,Thu,Fri | 08:45 | America/New_York | | yes |

- **Days:** `Daily` / `Weekdays` / `Weekends` / `Mon,Wed,Fri`
- **Time:** `09:00` or `9:00 AM`
- **Active:** `no` to pause a row.

## Project layout
```
index.js              Main service (connect → poll sheet → schedule)
src/whatsapp.js       Baileys connection + auto-reconnect
src/sheet.js          Reads the Google Sheet
src/schedule.js       Parses rows, timezone-aware "is it due?" logic
src/scheduler.js      Minute heartbeat, dedupe, anti-ban spacing
src/sender.js         Builds + sends messages (text/media), retries
src/store.js          Dedupe + send log (data/state.json)
src/config.js         Env-driven config
bin/*.js              link / list-groups / check-sheet / send-test / log
ecosystem.config.js   pm2 (24/7)
Dockerfile, docker-compose.yml   container deploy
```
