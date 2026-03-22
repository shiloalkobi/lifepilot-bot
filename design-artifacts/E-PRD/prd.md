# PRD — LifePilot Bot

**Version:** 1.0
**Date:** March 2026
**Status:** Active Development

---

## Overview

LifePilot is a Telegram bot (Node.js, Gemini 2.5 Flash) deployed on Render. It serves as Shilo Alkobi's personal AI assistant with full profile context, Google integrations, and real-time security alerts.

---

## Current Capabilities (Implemented)

| Feature | Status | Notes |
|---------|--------|-------|
| AI chat (Gemini 2.5 Flash) | ✅ Live | Hebrew + English, full profile context |
| Google Calendar — view/create/edit/delete | ✅ Live | Function calling |
| Gmail — unread emails | ✅ Live | Function calling |
| Pikud HaOref alerts | ✅ Live | 1s polling, 30 monitored areas |
| Social media content creation | ✅ Live | Instagram / Facebook / TikTok |
| Draft storage (social posts) | ✅ Live | JSON file |
| Conversation history | ✅ Live | Per chat ID |

---

## Planned Features — Phase 2

### F-01: Good Morning Daily Briefing
**Priority:** P0 | **Effort:** S

Every day at 08:00 Israel time, send:
- Today's calendar events
- Weather summary (OpenWeatherMap free API)
- Motivational quote
- One English word of the day

**Acceptance criteria:**
- Arrives 08:00 ±1 minute daily
- Survives Render restarts (cron rebuilt on startup)
- Weather in Hebrew

---

### F-02: Task Management
**Priority:** P0 | **Effort:** S

Natural language task CRUD via chat:
- "הוסף משימה: לסיים את ה-API של TTS"
- "הראה משימות פתוחות"
- "סמן כבוצע: API של TTS"

Storage: `data/tasks.json`

**Acceptance criteria:**
- Add / list / complete / delete tasks
- Tasks persist across restarts
- Filter by status (open / done)

---

### F-03: Health & CRPS Tracking
**Priority:** P0 | **Effort:** S

Log daily health entries:
- "כאב: 6/10, לאחר הליכה"
- "טיפול: ניקוי רגל"
- "תרופה: לקחתי קנאביס רפואי"

Storage: `data/health.json`

Weekly summary sent every Sunday at 10:00:
- Average pain level
- Treatment count
- Medication adherence

**Acceptance criteria:**
- Log entry saved with timestamp
- Weekly summary auto-sent
- "הראה לוג בריאות השבוע" returns formatted report

---

### F-04: Daily English Practice
**Priority:** P1 | **Effort:** S

Every day at 09:00:
- 5 English words with Hebrew translation
- Example sentence
- Previous day recap (show yesterday's words again)

Powered by Gemini (no external API needed).

**Acceptance criteria:**
- Delivered at 09:00 daily
- Words appropriate for beginner-intermediate level
- /english command triggers on-demand session

---

### F-05: Pomodoro Timer
**Priority:** P1 | **Effort:** XS

Commands:
- "פומודורו 25 דקות" → starts timer, sends alert when done
- "הפסקה 5 דקות" → break timer
- "בטל פומודורו" → cancels active timer

**Acceptance criteria:**
- Notification on completion
- Only one active timer at a time
- Works via natural language or /pomodoro command

---

### F-06: Tech News Summary
**Priority:** P1 | **Effort:** S

Daily at 12:00 — RSS digest:
- 3-5 items from tech feeds (TheMarker Tech, TechCrunch)
- AI-summarized in Hebrew (2 sentences per item)
- Filtered for: AI, SaaS, WordPress, cybersecurity

**Acceptance criteria:**
- Delivered at 12:00 daily
- No duplicate news items within 24h
- /news command triggers on-demand fetch

---

### F-07: Natural Language Reminders
**Priority:** P0 | **Effort:** M

"תזכיר לי מחר ב-14:00 לקחת כדור"
"תזכיר לי בעוד שעה לבדוק את הבניה"

Storage: `data/reminders.json`
Rebuilt from file on startup to survive restarts.

**Acceptance criteria:**
- Parse relative and absolute time in Hebrew
- Reminder fires ±30 seconds of specified time
- Survives Render restarts
- "הראה תזכורות" lists all pending reminders

---

### F-08: Medication Tracking
**Priority:** P0 | **Effort:** XS

Commands:
- "לקחתי כדור" → logs to health.json with timestamp
- "מה השעה האחרונה שלקחתי?" → returns last log entry
- Configurable medication list in .env or config

**Acceptance criteria:**
- Logs medication intake with timestamp
- Returns last intake on request
- Integrated with F-03 health log

---

### F-09: WordPress Site Monitor
**Priority:** P1 | **Effort:** S

Poll configured WordPress sites every 5 minutes:
- HTTP ping (expect 200)
- Alert immediately if site returns non-200 or times out

Sites configured via env var: `WP_SITES=https://site1.com,https://site2.com`

**Acceptance criteria:**
- Alert within 5 minutes of downtime
- Recovery notification when site back online
- Avoid alert spam (alert once, then silence until recovery)

---

### F-10: Weekly Summary
**Priority:** P1 | **Effort:** S

Every Sunday at 10:00:
- Tasks completed this week vs. open
- Health log summary (from F-03)
- Calendar events overview
- Reminder compliance

**Acceptance criteria:**
- Auto-sent Sunday 10:00
- /weekly command triggers on-demand
- Covers Mon–Sun of current week

---

### F-11: Notes & Code Snippets
**Priority:** P2 | **Effort:** S

"שמור הערה: הפורט של Render הוא PORT env var"
"שמור snippet: const x = require('x')"
"הראה הערות"
"חפש הערות: Render"

Storage: `data/notes.json`

**Acceptance criteria:**
- Save note with timestamp and optional tag
- List / search notes
- Delete note by ID

---

### F-12: Smart Daily Summary
**Priority:** P1 | **Effort:** M

Every day at 21:00:
- What was in the calendar today
- Tasks completed/missed
- Health log of the day
- Reminder for tomorrow's earliest event

**Acceptance criteria:**
- Auto-sent 21:00 daily
- /summary command triggers on-demand
- Skips sections with no data

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Uptime | 99% (Render free tier allows 90-day continuous) |
| Alert latency (Pikud HaOref) | < 3s end-to-end |
| AI response time | < 8s |
| Storage | JSON files, < 10MB total |
| Cost | $0/month (free tiers only) |

---

## Out of Scope (MVP)

- Web dashboard
- Multi-user support
- Database (PostgreSQL, MongoDB)
- Voice messages
- Image generation
