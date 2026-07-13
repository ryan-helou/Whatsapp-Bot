# WhatsApp Scheduled Group Bot — Build Plan

## Goal
Send scheduled, recurring messages (different content per group) to many existing
WhatsApp group chats. Message content and schedule live in a Google Sheet that
can be edited any time without touching code. Runs 24/7 on a cloud VPS.

## Chosen approach
- **Library:** [Baileys](https://github.com/WhiskeySockets/Baileys) (Node.js). Links to WhatsApp as a
  companion device (scan QR once). Can message existing groups of any size.
  Chosen over whatsapp-web.js because it's WebSocket-based (no headless Chrome) —
  lighter and more reliable for an always-on server.
- **Why not the official Meta Groups API:** it can only message groups *created through
  the API* (max 8 people, opt-in only). It cannot touch your existing groups. Ruled out.

## Config decisions (locked)
| Decision | Choice |
|---|---|
| Number | Main personal number (conservative anti-ban defaults; swappable later) |
| Hosting | Cloud VPS, always-on |
| Message/schedule source | Google Sheet (service-account read access) |
| Pattern | Recurring (daily/weekly at set times), different message per group |

## Google Sheet schema (the "database")
One row per scheduled message:

| Group Name | Group ID (JID) | Message | Days | Time | Timezone | Media URL | Active |
|---|---|---|---|---|---|---|---|
| Family | 12036...@g.us | Good morning ☀️ | Daily | 09:00 | America/New_York | | yes |
| Work Team | 98214...@g.us | Standup in 15 | Mon,Tue,Wed,Thu,Fri | 08:45 | America/New_York | | yes |

- **Days:** `Daily` or comma list `Mon,Wed,Fri`.
- **Media URL:** optional image/file link; blank = text only.
- **Active:** `no` to pause a row without deleting it.
- The bot re-reads the sheet every few minutes, so edits take effect without a restart.

## Components to build
1. **Connection module** — Baileys socket, persisted auth (scan QR once), auto-reconnect.
2. **Group discovery command** — one-off script that prints every group you're in with its
   JID, so you can paste Group IDs into the sheet by name.
3. **Sheet reader** — Google service account; polls the sheet, validates rows, caches schedule.
4. **Scheduler** — wakes every minute, finds rows due now (day + time + timezone aware),
   guards against double-sends within the same minute.
5. **Sender w/ anti-ban** — randomized delay between groups (~20–90s), small ± jitter on
   scheduled time, no simultaneous identical blasts.
6. **Send log** — records every send (ok/failed + error) to a local SQLite file and/or a
   "Log" tab in the sheet; retries transient failures.
7. **Deployment** — run under pm2/systemd on the VPS; restart-on-crash; survives reboots.

## Anti-ban defaults (because it's the main number)
- Only messages groups you're already a member of (lowest-risk pattern).
- Randomized per-group send delays + small schedule jitter (avoids robotic timing).
- Sensible volume; spread sends rather than firing all groups at the same second.
- Easy switch to a dedicated number later (delete auth folder, re-scan QR).

## What I'll need from you (setup, one-time)
- A cloud VPS (I'll give exact provider/steps — ~$5/mo) OR access to deploy for you.
- A Google Cloud service account + the Sheet shared with its email (I'll walk you through it).
- Your phone to scan the QR once to link the bot.

## Phases
1. **Scaffold + connect:** Node project, Baileys, QR link, "hello world" send to one group.
2. **Group discovery:** list groups → you fill the sheet.
3. **Sheet + scheduler:** read sheet, fire recurring sends with anti-ban timing.
4. **Logging + reliability:** send log, retries, crash recovery.
5. **Deploy to VPS:** always-on, auto-restart, reboot-safe.

## Risks (acknowledged)
- Automating a personal WhatsApp number violates WhatsApp ToS; ban is possible. We
  minimize it (own groups only, human-like timing), but cannot eliminate it.
- If the number is ever banned, we switch to a dedicated number and re-link.
