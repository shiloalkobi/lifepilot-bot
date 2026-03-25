# Agent Tools — Function Calling Definitions

**Version:** 1.0
**Date:** 2026-03-24
**Status:** Planning

All tools use Gemini's native function calling format (`@google/generative-ai` SDK).
Each tool maps to an exported function in an existing module.

---

## Tool Registry (27 Tools)

### Category 1 — Tasks

#### `add_task`
```json
{
  "name": "add_task",
  "description": "Add a new task to the task list. Use when user wants to remember to do something, create a to-do, or track an action item.",
  "parameters": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "description": "Task description in the user's language (Hebrew or English)"
      },
      "priority": {
        "type": "string",
        "enum": ["high", "medium", "low"],
        "description": "Task priority. Default: medium. Use high if user says 'דחוף', 'חשוב מאוד', 'urgent'."
      }
    },
    "required": ["text"]
  }
}
```
**Maps to:** `tasks.addTask(text)` — note: priority via `!` prefix not supported yet; implement in agent-tools.js

---

#### `get_tasks`
```json
{
  "name": "get_tasks",
  "description": "Get the current open task list. Use when user asks what tasks they have, wants to see todos, or needs context about pending work.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `tasks.getOpenTasks()` → returns `Task[]`

---

#### `complete_task`
```json
{
  "name": "complete_task",
  "description": "Mark a task as done. Use when user says they finished, completed, or did something.",
  "parameters": {
    "type": "object",
    "properties": {
      "task_index": {
        "type": "number",
        "description": "1-based task number from the task list"
      }
    },
    "required": ["task_index"]
  }
}
```
**Maps to:** `tasks.markDone(index)`

---

#### `delete_task`
```json
{
  "name": "delete_task",
  "description": "Delete a task from the list permanently.",
  "parameters": {
    "type": "object",
    "properties": {
      "task_index": {
        "type": "number",
        "description": "1-based task number"
      }
    },
    "required": ["task_index"]
  }
}
```
**Maps to:** `tasks.deleteTask(index)`

---

### Category 2 — Health

#### `log_health`
```json
{
  "name": "log_health",
  "description": "Log today's health check-in (pain level, mood, sleep hours, symptoms, notes). Use when user mentions how they feel, pain level, sleep, or health status. Can be partial — use null for unknown values.",
  "parameters": {
    "type": "object",
    "properties": {
      "pain": {
        "type": "number",
        "description": "Pain level 1-10. Required. Estimate from context: 'כאב חזק' → 8, 'קצת כאב' → 4, 'ללא כאב' → 1."
      },
      "mood": {
        "type": "number",
        "description": "Mood level 1-10. Optional. 'מצוין' → 9, 'סביר' → 6, 'לא טוב' → 3."
      },
      "sleep": {
        "type": "number",
        "description": "Hours slept last night. Optional."
      },
      "symptoms": {
        "type": "string",
        "description": "Any physical symptoms mentioned. Optional."
      },
      "notes": {
        "type": "string",
        "description": "Free text health notes. Optional."
      }
    },
    "required": ["pain"]
  }
}
```
**Maps to:** New `health.logDirect({ pain, mood, sleep, symptoms, notes })` function (to be created — writes directly without interactive check-in flow)

---

#### `get_health_today`
```json
{
  "name": "get_health_today",
  "description": "Get today's health entry. Use to check if user already logged health today, or to show current status.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `health.getTodayHealth()` → `HealthEntry | null`

---

#### `get_health_summary`
```json
{
  "name": "get_health_summary",
  "description": "Get health statistics for the past N days. Use for weekly reviews, trend analysis, or 'איך הייתה הבריאות שלי השבוע'.",
  "parameters": {
    "type": "object",
    "properties": {
      "days": {
        "type": "number",
        "description": "Number of days to look back. Default: 7."
      }
    },
    "required": []
  }
}
```
**Maps to:** `health.getWeekSummary(days)` → HTML string (strip tags for agent consumption)

---

### Category 3 — Medications

#### `get_med_status`
```json
{
  "name": "get_med_status",
  "description": "Get today's medication status — what's taken, pending, or skipped. Use when user asks about meds or when checking in about health.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `medications.getTodayMedStatus()` → `[{ name, taken, skipped, pending }]`

---

#### `mark_med_taken`
```json
{
  "name": "mark_med_taken",
  "description": "Mark a medication as taken. Use when user says they took a medication.",
  "parameters": {
    "type": "object",
    "properties": {
      "medication_name": {
        "type": "string",
        "description": "Name of the medication (case-insensitive)"
      }
    },
    "required": ["medication_name"]
  }
}
```
**Maps to:** `medications.markTaken(name)`

---

### Category 4 — Reminders

#### `add_reminder`
```json
{
  "name": "add_reminder",
  "description": "Set a reminder for a specific time. Use when user says 'תזכיר לי', 'remind me', or mentions doing something at a specific time.",
  "parameters": {
    "type": "object",
    "properties": {
      "task": {
        "type": "string",
        "description": "What to remind about"
      },
      "remind_at": {
        "type": "string",
        "description": "ISO 8601 datetime string for when to send reminder. The agent must calculate this based on current time + relative/absolute references."
      }
    },
    "required": ["task", "remind_at"]
  }
}
```
**Maps to:** `reminders.addReminderDirect(chatId, task, remindAt)` — new function that bypasses Gemini parse (agent already parsed intent)

---

#### `get_reminders`
```json
{
  "name": "get_reminders",
  "description": "List all pending reminders.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `reminders.listPending(chatId)`

---

#### `delete_reminder`
```json
{
  "name": "delete_reminder",
  "description": "Delete a pending reminder by ID.",
  "parameters": {
    "type": "object",
    "properties": {
      "reminder_id": {
        "type": "number",
        "description": "Reminder ID from the pending list"
      }
    },
    "required": ["reminder_id"]
  }
}
```
**Maps to:** `reminders.deleteReminder(chatId, id)`

---

### Category 5 — Notes

#### `save_note`
```json
{
  "name": "save_note",
  "description": "Save a note or snippet. Use when user wants to remember information, save code, store an idea, or capture something for later.",
  "parameters": {
    "type": "object",
    "properties": {
      "content": {
        "type": "string",
        "description": "Full note content"
      }
    },
    "required": ["content"]
  }
}
```
**Maps to:** `notes.addNote(content)` (includes Gemini tagging)

---

#### `search_notes`
```json
{
  "name": "search_notes",
  "description": "Search saved notes by keyword.",
  "parameters": {
    "type": "object",
    "properties": {
      "keyword": {
        "type": "string",
        "description": "Search term"
      }
    },
    "required": ["keyword"]
  }
}
```
**Maps to:** `notes.searchNotes(keyword)`

---

#### `get_recent_notes`
```json
{
  "name": "get_recent_notes",
  "description": "Get the most recent notes.",
  "parameters": {
    "type": "object",
    "properties": {
      "count": {
        "type": "number",
        "description": "Number of notes to retrieve. Default: 5."
      }
    },
    "required": []
  }
}
```
**Maps to:** `notes.load().slice(-count).reverse()`

---

### Category 6 — English Learning

#### `get_daily_word`
```json
{
  "name": "get_daily_word",
  "description": "Get today's English word for learning. Use when user asks for a word, wants to practice English, or asks what today's word is.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `english.getDailyWord()` + `english.formatWord(word)`

---

#### `get_english_stats`
```json
{
  "name": "get_english_stats",
  "description": "Get English learning streak and statistics.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `english.formatStreak()`

---

### Category 7 — Pomodoro

#### `start_pomodoro`
```json
{
  "name": "start_pomodoro",
  "description": "Start a Pomodoro focus session. Use when user wants to focus, work, or start a timed session.",
  "parameters": {
    "type": "object",
    "properties": {
      "minutes": {
        "type": "number",
        "description": "Session length in minutes. Default: 25."
      }
    },
    "required": []
  }
}
```
**Maps to:** `pomodoro.startPomo(bot, chatId, minutes)`

---

#### `stop_pomodoro`
```json
{
  "name": "stop_pomodoro",
  "description": "Stop the current Pomodoro session.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `pomodoro.stopPomo(bot, chatId)`

---

#### `get_pomodoro_stats`
```json
{
  "name": "get_pomodoro_stats",
  "description": "Get today's Pomodoro session statistics.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `pomodoro.getTodayPomoStats()`

---

### Category 8 — News

#### `get_tech_news`
```json
{
  "name": "get_tech_news",
  "description": "Fetch and summarize today's tech news from Hacker News.",
  "parameters": {
    "type": "object",
    "properties": {
      "full": {
        "type": "boolean",
        "description": "If true, return 10 stories with links. If false (default), return 5 stories with AI summary."
      }
    },
    "required": []
  }
}
```
**Maps to:** `news.sendNews(bot, chatId, full)` — NOTE: this sends directly to chat, so agent just triggers it

---

### Category 9 — Sites

#### `get_site_status`
```json
{
  "name": "get_site_status",
  "description": "Get status of all monitored websites.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `sites.load()` + `sites.formatList()`

---

#### `check_sites_now`
```json
{
  "name": "check_sites_now",
  "description": "Immediately check all monitored websites for up/down status.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** `sites.runChecks(bot, chatId)`

---

### Category 10 — Calendar (via google.js)

#### `get_calendar_events`
```json
{
  "name": "get_calendar_events",
  "description": "Get upcoming Google Calendar events. Use when user asks about schedule, meetings, or upcoming events.",
  "parameters": {
    "type": "object",
    "properties": {
      "days": {
        "type": "number",
        "description": "Number of days to look ahead. Default: 7."
      }
    },
    "required": []
  }
}
```
**Maps to:** `google.getCalendarEvents(days)`

---

#### `create_calendar_event`
```json
{
  "name": "create_calendar_event",
  "description": "Create a new Google Calendar event.",
  "parameters": {
    "type": "object",
    "properties": {
      "summary": { "type": "string", "description": "Event title" },
      "start":   { "type": "string", "description": "ISO 8601 start datetime" },
      "end":     { "type": "string", "description": "ISO 8601 end datetime" }
    },
    "required": ["summary", "start", "end"]
  }
}
```
**Maps to:** `google.createCalendarEvent(summary, start, end)`

---

### Category 11 — Context & Weather

#### `get_current_context`
```json
{
  "name": "get_current_context",
  "description": "Get current time, day, and today's summary context (tasks, health, meds). Use at the start of complex requests to understand the user's current situation.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```
**Maps to:** New `agent-tools.js` function that returns:
```json
{
  "datetime": "2026-03-24T19:30:00+03:00",
  "day_hebrew": "יום שלישי",
  "open_tasks": 3,
  "health_logged_today": false,
  "meds_pending": ["Acamol"],
  "reminders_pending": 2,
  "pomo_active": false
}
```

---

#### `fetch_web_page`
```json
{
  "name": "fetch_web_page",
  "description": "Fetch and extract text content from a URL for summarization or analysis.",
  "parameters": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "Full URL to fetch"
      }
    },
    "required": ["url"]
  }
}
```
**Maps to:** New `agent-tools.js` fetch function using Node.js `https` module. Max 3000 chars returned.

---

## Tool Execution Map (agent-tools.js)

```javascript
const TOOL_HANDLERS = {
  add_task:             ({ text, priority }, _)     => tasks.addTask(text),
  get_tasks:            (_, _)                      => tasks.getOpenTasks(),
  complete_task:        ({ task_index }, _)          => tasks.markDone(task_index),
  delete_task:          ({ task_index }, _)          => tasks.deleteTask(task_index),
  log_health:           (args, _)                   => health.logDirect(args),
  get_health_today:     (_, _)                      => health.getTodayHealth(),
  get_health_summary:   ({ days = 7 }, _)           => health.getRawWeekData(days),
  get_med_status:       (_, _)                      => medications.getTodayMedStatus(),
  mark_med_taken:       ({ medication_name }, _)    => medications.markTaken(medication_name),
  add_reminder:         ({ task, remind_at }, ctx)  => reminders.addReminderDirect(ctx.chatId, task, remind_at),
  get_reminders:        (_, ctx)                    => reminders.listPending(ctx.chatId),
  delete_reminder:      ({ reminder_id }, ctx)      => reminders.deleteReminder(ctx.chatId, reminder_id),
  save_note:            ({ content }, _)            => notes.addNote(content),
  search_notes:         ({ keyword }, _)            => notes.searchNotes(keyword),
  get_recent_notes:     ({ count = 5 }, _)          => notes.load().slice(-(count)).reverse(),
  get_daily_word:       (_, _)                      => english.getDailyWordSync(),
  get_english_stats:    (_, _)                      => english.getStats(),
  start_pomodoro:       ({ minutes = 25 }, ctx)     => pomodoro.startPomo(ctx.bot, ctx.chatId, minutes),
  stop_pomodoro:        (_, ctx)                    => pomodoro.stopPomo(ctx.bot, ctx.chatId),
  get_pomodoro_stats:   (_, _)                      => pomodoro.getTodayPomoStats(),
  get_tech_news:        ({ full = false }, ctx)     => news.sendNews(ctx.bot, ctx.chatId, full),
  get_site_status:      (_, _)                      => sites.load(),
  check_sites_now:      (_, ctx)                    => sites.runChecks(ctx.bot, ctx.chatId),
  get_calendar_events:  ({ days = 7 }, _)           => google.getCalendarEvents(days),
  create_calendar_event: ({ summary, start, end }, _) => google.createCalendarEvent(summary, start, end),
  get_current_context:  (_, ctx)                   => buildCurrentContext(ctx.chatId),
  fetch_web_page:       ({ url }, _)               => fetchWebPage(url),
};
```

---

## New Functions Required in Existing Modules

These small additions are needed to support the agent layer:

| Module | Function | Purpose |
|--------|----------|---------|
| `health.js` | `logDirect({ pain, mood, sleep, symptoms, notes })` | Write health entry without interactive flow |
| `reminders.js` | `addReminderDirect(chatId, task, remindAtISO)` | Add reminder with pre-parsed time (skip Gemini) |
| `english.js` | `getStats()` | Return raw stats object for agent use |
| `health.js` | `getRawWeekData(days)` | Return raw data array (not HTML) for agent |

All are small additions — no refactoring of existing functions.
