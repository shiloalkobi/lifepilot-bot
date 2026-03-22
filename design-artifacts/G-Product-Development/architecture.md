# Architecture — LifePilot Bot

**Last updated:** March 2026

---

## System Overview

```
Telegram App (Shilo's phone)
        │
        │  HTTPS (getUpdates polling)
        ▼
┌─────────────────────────────────────────────────────┐
│                 Render (Free Tier)                   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │              bot/index.js (main)              │   │
│  │  • HTTP server (PORT env) — keeps Render live │   │
│  │  • Starts telegram.js polling                 │   │
│  │  • Starts oref.js monitor (1s)                │   │
│  │  • Starts scheduled jobs (cron-like)          │   │
│  └──────┬────────────────────┬───────────────────┘   │
│         │                    │                        │
│  ┌──────▼──────┐    ┌────────▼────────┐              │
│  │ telegram.js │    │    oref.js      │              │
│  │ (message    │    │ (alert monitor) │              │
│  │  routing)   │    │ 1s polling →    │              │
│  └──────┬──────┘    │ oref.org.il     │              │
│         │           └─────────────────┘              │
│  ┌──────▼──────┐                                     │
│  │  claude.js  │                                     │
│  │  Gemini 2.5 │                                     │
│  │  Flash +    │                                     │
│  │  Tools      │                                     │
│  └──────┬──────┘                                     │
│         │                                            │
│  ┌──────▼──────┐   ┌─────────────┐                  │
│  │  google.js  │   │  social.js  │                  │
│  │  Calendar + │   │  Drafts     │                  │
│  │  Gmail      │   │  (JSON)     │                  │
│  └─────────────┘   └─────────────┘                  │
└─────────────────────────────────────────────────────┘
        │                    │
        ▼                    ▼
  Google APIs          oref.org.il
  (Calendar, Gmail)    (free, poll-based)
```

---

## Module Responsibilities

### `bot/index.js`
Entry point. Validates env vars, starts HTTP server (Render requirement), starts bot and oref monitor. Will also start scheduled jobs (morning briefing, reminders, etc).

### `bot/telegram.js`
Owns the TelegramBot instance. Routes all messages to `askClaude()`. Handles `/start`, `/reset`, `/help`. Has polling_error handler with 409-recovery (stop → 5s → restart).

### `bot/claude.js`
All AI logic lives here. Builds `SYSTEM_PROMPT` (static instructions + shilo_profile.md loaded from disk). Sends messages to Gemini with full conversation history. Executes function calls in a loop (max 5 rounds).

### `bot/oref.js`
Stateless poller. Fires every 1 second against oref.org.il. Maintains `Set<alertId>` for deduplication. On matched alert: sends Telegram message + starts shelter countdown. Health-check log every 60s.

### `bot/google.js`
Wraps `googleapis`. Loads OAuth2 token from env or file. Exposes: `getCalendarEvents`, `createCalendarEvent`, `updateCalendarEvent`, `deleteCalendarEvent`, `findEventsByQuery`, `getUnreadEmails`.

### `bot/social.js`
Manages social media post drafts. Read/write to `data/drafts.json`. Exposes: `saveDraft`, `listDrafts`, `deleteDraft`.

### `bot/history.js`
In-memory `Map<chatId, messages[]>`. Stores last N messages per chat for Gemini conversation context. Resets on process restart.

---

## Message Flow

```
User sends message
        │
telegram.js: bot.on('message')
        │
        ├── /command → handle locally (no AI)
        │
        └── text message →
              history.addMessage(chatId, 'user', text)
                      │
              claude.js: askClaude(history)
                      │
              Gemini API: sendMessage + function_call loop
                      │
              ┌───────┴─────────┐
              │  Function call? │
              │  yes → execute  │
              │  no → final txt │
              └───────┬─────────┘
                      │
              history.addMessage(chatId, 'assistant', reply)
                      │
              bot.sendMessage(chatId, reply, HTML)
```

---

## Scheduled Jobs Architecture (Planned)

All scheduled jobs will use `setInterval` + time-of-day checks (no external cron dependency):

```javascript
// Pattern for all scheduled features
setInterval(() => {
  const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const [time] = now.split(' ').slice(-1);
  if (time.startsWith('08:00') && !todaySent.morning) {
    todaySent.morning = true;
    sendMorningBriefing();
  }
}, 30_000); // check every 30s
```

Jobs to implement:
| Job | Time | Feature |
|-----|------|---------|
| Morning briefing | 08:00 | F-01 |
| English words | 09:00 | F-04 |
| News digest | 12:00 | F-06 |
| Evening summary | 21:00 | F-12 |
| Weekly summary | Sun 10:00 | F-10 |
| Reminder checker | Every 30s | F-07 |
| WP monitor | Every 5min | F-09 |

---

## Data Flow: Reminders (Planned F-07)

```
User: "תזכיר לי מחר ב-14:00 לקחת כדור"
        │
claude.js: AI parses → calls save_reminder tool
        │
reminders.js: appends to data/reminders.json
        │
On startup: load all future reminders → schedule setTimeout
        │
At trigger time: bot.sendMessage(chatId, reminderText)
```

---

## Deployment Notes

- Render free tier: 512MB RAM, spins down after 15min inactivity
- HTTP server keeps it alive (Render's uptime check pings PORT)
- No persistent disk on free tier — `data/` files reset on each deploy
- To persist data: use Render Persistent Disk ($7/mo) or store in env var

---

## Security Considerations

- Bot token in env var (never committed)
- OAuth2 token in env var `GOOGLE_TOKEN_JSON`
- oref.js: read-only external API, no auth
- No user input reaches shell/eval — all AI-mediated
- 409 recovery: safe re-polling, no token rotation needed
