# Agent Proactive Behavior — Rules & Design

**Version:** 1.0
**Date:** 2026-03-24
**Status:** Planning

---

## Overview

The agent doesn't just respond — it **initiates** conversations when it detects patterns, missed habits, or opportunities. This is the difference between a passive command bot and a true personal assistant.

All proactive checks run via a **daily cron job** (once per day at a scheduled time), plus event-driven hooks triggered by existing bot activity.

---

## Proactive Trigger System

```
data/agent-memory.json
        │
        ▼
bot/agent-proactive.js
  - loadTriggerRules()
  - runDailyChecks(bot, chatId)    ← called by cron at 09:00 IL
  - runEventChecks(event, data)    ← called by modules on events
        │
        ▼
  Triggers that fire → buildProactiveMessage(reason, context)
        │
        ▼
  bot.sendMessage(chatId, message)
```

---

## Trigger Rules

### 1. Health — No Log

**Condition:** No health entry for 2+ consecutive days

**When checked:** Daily at 09:00 IL (morning check-in window)

**Message:**
```
"היי, {{DAYS}} ימים בלי דיווח בריאות. הכל בסדר? /health"
```

**Suppression:** Don't send if user already messaged in the last 2 hours (they're active, they'll log when ready)

---

### 2. Health — Pain Pattern

**Condition:** Rolling analysis of last 14 days shows:
- Pain ≥ 7 on 3+ consecutive days
- OR clear correlation: average pain higher (≥1.5 points) on days with sleep < 6 hours

**When checked:** Daily at 20:00 IL (after day's data is in)

**Message examples:**
```
"שמתי לב שהכאב היה גבוה 3 ימים ברצף. רוצה לרשום הערה לרופא?"
"ביום שישנת פחות מ-6 שעות, הכאב בממוצע גבוה ב-2 נקודות. כדאי לישון יותר?"
```

**Rate limit:** Max once per 7 days for the same pattern insight

---

### 3. Tasks — Pile-up

**Condition:** 8+ open tasks, none completed in the last 3 days

**When checked:** Daily at 10:00 IL

**Message:**
```
"יש {{COUNT}} משימות פתוחות ו-3 ימים בלי השלמה. רוצה שנתעדף ביחד? /tasks"
```

**Suppression:** Don't send if user was active with tasks today

---

### 4. Tasks — Good Day Acknowledgment

**Condition:** 5+ tasks completed in one day (exceptional productivity)

**When checked:** Event-driven — triggered by `markDone()` call

**Message:**
```
"5 משימות היום — יום מאוד פרודוקטיבי! 💪 קח הפסקה."
```

**Rate limit:** Max once per week

---

### 5. English — Streak Broken

**Condition:** No English practice for 3 consecutive days

**When checked:** Daily at 09:30 IL

**Message:**
```
"3 ימים בלי מילת אנגלית. רוצה אחת עכשיו? /english"
```

**Suppression:** Don't send on Shabbat (Friday evening → Saturday evening) — detection: check day of week

---

### 6. Medications — Pending All Day

**Condition:** A medication is marked "pending" and it's 4+ hours past its scheduled time

**When checked:** Event-driven — triggered when medication scheduler runs

**Message:**
```
"{{MED_NAME}} מתוכנן ל-{{TIME}} ועדיין לא לקחת. הכל בסדר? /med taken {{MED_NAME}}"
```

**Note:** This supplements (doesn't replace) the existing medication scheduler reminders

---

### 7. Reminders — Morning Briefing

**Condition:** User has 3+ upcoming reminders today

**When checked:** Injected into morning message (scheduler.js already sends it)

**Action:** The morning message builder checks reminders and includes them.
No separate proactive message needed — extend `buildMorningMessage()`.

---

### 8. Weekly Momentum Check (Friday)

**Condition:** Every Friday at 13:00 IL

**Message:**
```
"השבוע: {{COMPLETED}} משימות הושלמו, {{PAIN_AVG}} ממוצע כאב.
{{AI_GENERATED_1_LINE_INSIGHT}}
סיכום מלא: /weekly"
```

---

### 9. Site Down Alert (Already Implemented)

**Condition:** `sites.js` already handles this
**Action:** Already sends immediate alert — no changes needed

---

### 10. Oref Alert (Already Implemented)

**Condition:** `oref.js` already handles this
**Action:** Already sends alert — no changes needed

---

## Implementation: agent-proactive.js

```javascript
'use strict';

const { getOpenTasks, getCompletedToday } = require('./tasks');
const { getTodayHealth, getRawWeekData } = require('./health');
const { getTodayMedStatus } = require('./medications');
const { loadMemory, saveMemory } = require('./agent-memory');

const PROACTIVE_COOLDOWNS = {
  health_no_log:    2 * 24 * 60 * 60 * 1000,  // 2 days
  health_pattern:   7 * 24 * 60 * 60 * 1000,  // 7 days
  tasks_pileup:     3 * 24 * 60 * 60 * 1000,  // 3 days
  tasks_great_day:  7 * 24 * 60 * 60 * 1000,  // 7 days
  english_streak:   3 * 24 * 60 * 60 * 1000,  // re-fires every 3 days
};

function cooldownPassed(memory, triggerKey) {
  const lastSent = memory.proactiveSent?.[triggerKey];
  if (!lastSent) return true;
  return Date.now() - new Date(lastSent).getTime() > PROACTIVE_COOLDOWNS[triggerKey];
}

function recordSent(memory, triggerKey) {
  memory.proactiveSent = memory.proactiveSent || {};
  memory.proactiveSent[triggerKey] = new Date().toISOString();
}

async function runDailyChecks(bot, chatId) {
  const memory = loadMemory(chatId);
  const messages = [];

  // Check 1: Health no-log
  if (cooldownPassed(memory, 'health_no_log')) {
    const health14 = getRawWeekData(14);
    const today = todayIL();
    const yesterday = yesterdayIL();
    const noEntryFor = !health14.find(e => e.date === today || e.date === yesterday);
    if (noEntryFor) {
      messages.push({ key: 'health_no_log', text: 'יומיים בלי דיווח בריאות. הכל בסדר? /health' });
    }
  }

  // Check 2: Tasks pile-up
  if (cooldownPassed(memory, 'tasks_pileup')) {
    const open = getOpenTasks();
    const completedRecent = getCompletedToday(); // extend to last 3 days
    if (open.length >= 8 && completedRecent.length === 0) {
      messages.push({ key: 'tasks_pileup', text: `יש ${open.length} משימות פתוחות. רוצה לתעדף? /tasks` });
    }
  }

  // Send all messages
  for (const { key, text } of messages) {
    await bot.sendMessage(chatId, text);
    recordSent(memory, key);
  }

  saveMemory(chatId, memory);
}

module.exports = { runDailyChecks };
```

---

## Proactive Cron Schedule

Integrated into `bot/scheduler.js`:

```javascript
// 09:00 IL = 06:00 UTC — morning proactive checks
cron.schedule('0 6 * * *', () => agentProactive.runDailyChecks(bot, chatId), { timezone: 'UTC' });
```

---

## Anti-Spam Rules

1. **Cooldowns:** Each trigger has a minimum time between fires (see table above)
2. **User activity suppression:** If user sent a message in the last 2 hours, skip that check
3. **Maximum per day:** No more than 2 proactive messages per day total
4. **Time-of-day window:** Only send proactive messages between 08:00-21:00 IL
5. **No stacking:** If multiple triggers fire on the same day, send only the 2 highest-priority ones

**Priority order (highest first):**
1. Medication pending (time-sensitive)
2. Health no-log (habit-critical)
3. Tasks pile-up (productivity)
4. Pain pattern (insight)
5. English streak (low urgency)

---

## Proactive vs Reactive

| Type | Trigger | Example |
|------|---------|---------|
| Reactive | User sends message | Any message → agent responds |
| Scheduled | Time-based cron | Morning briefing at 07:00 |
| Event-driven | Module action | Great task day → acknowledge |
| Pattern-based | Data analysis | Pain/sleep correlation |

**Key principle:** Proactive messages should feel like a caring friend noticing something — not a nagging app sending notifications.
