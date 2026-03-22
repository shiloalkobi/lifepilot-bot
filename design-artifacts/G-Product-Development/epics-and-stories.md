# Epics & User Stories — LifePilot Bot

**Last updated:** March 2026
**Methodology:** BMAD

---

## Epic 1: Daily Routine Automation

*Auto-send the right information at the right time so Shilo starts and ends each day without friction.*

### Story 1.1 — Morning Briefing
**As** Shilo,
**I want** to receive a morning summary at 08:00 every day
**So that** I know my schedule, weather, and an English word before I start working.

**Acceptance criteria:**
- [ ] Arrives at 08:00 Israel time (±1 min)
- [ ] Contains: today's calendar events, weather (Hebrew), motivational quote, 1 English word
- [ ] Survives Render restart (scheduler rebuilt on startup)
- [ ] /morning command triggers on-demand

**Effort:** S | **Priority:** P0

---

### Story 1.2 — Evening Summary
**As** Shilo,
**I want** a daily summary at 21:00
**So that** I can close the day knowing what was done and what's tomorrow.

**Acceptance criteria:**
- [ ] Today's completed vs. missed tasks
- [ ] Health log entries of the day
- [ ] Tomorrow's first calendar event
- [ ] /summary command triggers on-demand

**Effort:** M | **Priority:** P1

---

### Story 1.3 — Weekly Summary
**As** Shilo,
**I want** a weekly recap every Sunday at 10:00
**So that** I can review the week's progress across tasks, health, and projects.

**Acceptance criteria:**
- [ ] Tasks: done count vs. open count
- [ ] Health: avg pain level, treatment count
- [ ] Calendar: event count for the week
- [ ] /weekly command triggers on-demand

**Effort:** S | **Priority:** P1

---

## Epic 2: Task Management

*Replace mental task lists with a simple, conversational system.*

### Story 2.1 — Add Task
**As** Shilo,
**I want** to add a task in natural Hebrew
**So that** I don't forget things I need to do.

**Example:** "הוסף משימה: לסיים את ה-API של TTS"

**Acceptance criteria:**
- [ ] Task saved to data/tasks.json with timestamp
- [ ] Confirmation message with task ID
- [ ] Works via natural language (AI-mediated)

**Effort:** S | **Priority:** P0

---

### Story 2.2 — List & Complete Tasks
**As** Shilo,
**I want** to see my open tasks and mark them done
**So that** I can track progress.

**Examples:**
- "הראה משימות פתוחות"
- "סמן כבוצע: API של TTS"
- "מחק משימה 3"

**Acceptance criteria:**
- [ ] List shows ID, title, creation date
- [ ] Mark complete by ID or name match
- [ ] Completed tasks hidden from default list

**Effort:** S | **Priority:** P0

---

## Epic 3: Health Tracking

*Give Shilo a simple way to log and review his CRPS condition.*

### Story 3.1 — Log Pain Entry
**As** Shilo,
**I want** to log my pain level and activity
**So that** I can track patterns and share data with doctors.

**Example:** "כאב: 7/10, אחרי עמידה ממושכת"

**Acceptance criteria:**
- [ ] Entry saved with timestamp, level (1-10), note
- [ ] Confirmation message
- [ ] Stored in data/health.json

**Effort:** XS | **Priority:** P0

---

### Story 3.2 — Medication Tracking
**As** Shilo,
**I want** to log when I take medication
**So that** I don't double-dose or miss doses.

**Examples:**
- "לקחתי כדור"
- "מתי לקחתי כדור לאחרונה?"

**Acceptance criteria:**
- [ ] Log entry with timestamp
- [ ] Last intake returned on query
- [ ] Stored in same health.json as pain log

**Effort:** XS | **Priority:** P0

---

### Story 3.3 — Weekly Health Report
**As** Shilo,
**I want** an automatic health summary every Sunday
**So that** I can see trends without manual analysis.

**Acceptance criteria:**
- [ ] Average pain level for the week
- [ ] Number of treatment days
- [ ] Medication adherence count
- [ ] Auto-sent Sunday 10:00 (merged with Story 1.3)

**Effort:** S | **Priority:** P1

---

## Epic 4: Learning & Growth

*Build consistent daily habits for English and professional development.*

### Story 4.1 — Daily English Practice
**As** Shilo,
**I want** to receive 5 English words every morning at 09:00
**So that** I build vocabulary consistently.

**Acceptance criteria:**
- [ ] 5 words + Hebrew translation + example sentence
- [ ] Appropriate for B1-B2 level
- [ ] Yesterday's words shown first (spaced repetition lite)
- [ ] /english command triggers on-demand

**Effort:** S | **Priority:** P1

---

### Story 4.2 — Tech News Digest
**As** Shilo,
**I want** a curated tech news summary at 12:00
**So that** I stay current on AI, SaaS, and WordPress without information overload.

**Acceptance criteria:**
- [ ] 3-5 items from RSS feeds (AI-filtered for relevance)
- [ ] Each item: title + 2-sentence Hebrew summary
- [ ] No duplicate items within 24h
- [ ] /news command triggers on-demand

**Effort:** S | **Priority:** P1

---

## Epic 5: Productivity Tools

*Lightweight tools that reduce friction in Shilo's work sessions.*

### Story 5.1 — Pomodoro Timer
**As** Shilo,
**I want** to start a Pomodoro timer via chat
**So that** I work in focused sessions with proper breaks.

**Examples:**
- "פומודורו 25 דקות"
- "הפסקה 5 דקות"
- "בטל פומודורו"

**Acceptance criteria:**
- [ ] Notification on completion
- [ ] Only one active timer at a time
- [ ] Timer survives normal message flow (non-blocking)

**Effort:** XS | **Priority:** P1

---

### Story 5.2 — Natural Language Reminders
**As** Shilo,
**I want** to set reminders in natural Hebrew
**So that** I don't miss important tasks or medication.

**Examples:**
- "תזכיר לי בעוד שעה לבדוק הבניה"
- "תזכיר לי מחר ב-14:00 לטפל ברגל"

**Acceptance criteria:**
- [ ] Parses relative ("בעוד שעה") and absolute ("מחר ב-14:00") time
- [ ] Reminder fires ±30s of target time
- [ ] Persists across restarts (data/reminders.json)
- [ ] "הראה תזכורות" lists all pending

**Effort:** M | **Priority:** P0

---

### Story 5.3 — Notes & Code Snippets
**As** Shilo,
**I want** to save and search short notes from the chat
**So that** I can capture ideas and code patterns without leaving Telegram.

**Examples:**
- "שמור הערה: GROQ_API_KEY לא בשימוש עוד"
- "שמור snippet: const port = process.env.PORT || 3000"
- "חפש הערות: PORT"

**Acceptance criteria:**
- [ ] Save with timestamp and optional tag
- [ ] Full-text search
- [ ] List all / delete by ID

**Effort:** S | **Priority:** P2

---

## Epic 6: Infrastructure Monitoring

*Proactively alert Shilo when his sites or systems go down.*

### Story 6.1 — WordPress Site Monitor
**As** Shilo,
**I want** to be notified when any of my WordPress sites goes down
**So that** I can respond quickly before visitors are affected.

**Acceptance criteria:**
- [ ] Polls all WP_SITES env var URLs every 5 minutes
- [ ] Alert within 5 minutes of downtime
- [ ] Recovery notification when site returns
- [ ] No repeated alerts (one alert per incident)

**Effort:** S | **Priority:** P1

---

## Story Map Summary

| Epic | Stories | P0 | P1 | P2 |
|------|---------|----|----|-----|
| Daily Routine | 3 | 1 | 2 | 0 |
| Task Management | 2 | 2 | 0 | 0 |
| Health Tracking | 3 | 2 | 1 | 0 |
| Learning | 2 | 0 | 2 | 0 |
| Productivity | 3 | 1 | 1 | 1 |
| Monitoring | 1 | 0 | 1 | 0 |
| **Total** | **14** | **6** | **7** | **1** |

---

## Implementation Order

**Sprint 1 (P0 stories):**
1. Story 3.1 — Pain log
2. Story 3.2 — Medication log
3. Story 2.1 + 2.2 — Task management
4. Story 5.2 — Reminders
5. Story 1.1 — Morning briefing

**Sprint 2 (P1 stories):**
6. Story 4.1 — English practice
7. Story 5.1 — Pomodoro
8. Story 1.2 — Evening summary
9. Story 4.2 — News digest
10. Story 6.1 — WP monitor

**Sprint 3 (P2 + polish):**
11. Story 5.3 — Notes
12. Story 1.3 + 3.3 — Weekly summaries
