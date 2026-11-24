<div align="center">

# WhatsApp Scheduled Group Bot

**A bot that sends planned, repeating messages to WhatsApp group chats, using a Google Sheet as its to-do list.**

<!-- facts --><img alt="Schedule in: a Google Sheet" src="https://img.shields.io/badge/Schedule_in-a_Google_Sheet-24292f?style=for-the-badge"> <img alt="Checks: every minute" src="https://img.shields.io/badge/Checks-every_minute-24292f?style=for-the-badge"> <img alt="Control from: Telegram" src="https://img.shields.io/badge/Control_from-Telegram-24292f?style=for-the-badge">

</div>

<br>

Some groups need the same reminder every week, like a morning hello, a practice reminder or "whose turn is it this week." This bot runs around the clock and sends those messages at the right time, to the right group, so nobody has to remember. You change what it sends by editing a Google Sheet, without touching any code. It connects through a regular WhatsApp account and sends messages at natural, human-like intervals.

## What you can do with it

- List messages in a Google Sheet: which group, what to say, which days and what time. Pause any row by marking it inactive.
- Send daily, weekday, weekend or specific-day messages, in any time zone, with an optional image or file.
- Use automatic fill-ins, such as whose turn it is in a weekly rotation or the date of the coming Saturday.
- Optionally manage the schedule by texting a Telegram bot in plain English ("add a 9am good-morning to the family group", "send the cleanup message now"). An AI turns your message into the change and asks before doing anything destructive.
- Get an optional daily summary of what went out, and an alert if something failed.
