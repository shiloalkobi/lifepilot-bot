# Agent Memory System Design

**Version:** 1.0
**Date:** 2026-03-24
**Status:** Planning

---

## Overview

The agent builds a persistent model of Shilo's patterns, preferences, and context over time. This memory is injected into every Gemini call so the agent can give contextually relevant responses.

**Storage:** `data/agent-memory.json` (single file, per-user data)
**Access:** `bot/agent-memory.js` — load, update, save functions

---

## Memory Schema

```json
{
  "chatId": "758752313",
  "lastUpdated": "2026-03-24T19:30:00.000Z",

  "preferences": {
    "language": "he",
    "responseLength": "short",
    "activeHoursStart": "09:00",
    "activeHoursEnd": "22:00",
    "preferredReminderLead": 15
  },

  "patterns": {
    "healthReportTime": "20:00",
    "averagePainLevel": 5.2,
    "painSleepCorrelation": true,
    "mostProductiveDays": ["ראשון", "שלישי"],
    "averageTasksPerDay": 2.3,
    "medicationAdherenceRate": 0.87,
    "englishPracticeRate": 4,
    "pomodoroSessions": 1.5,
    "lastActiveDate": "2026-03-24"
  },

  "context": {
    "currentProjects": ["AI App Builder", "WordPress Security Lab"],
    "openGoals": ["להשלים MVP ל-AI App Builder", "ללמוד penetration testing"],
    "recentTopics": ["node.js webhooks", "Gemini function calling", "CRPS management"],
    "lastConversationSummary": "שאל על deployment ב-Render ותיקון באג ב-oref.js"
  },

  "proactiveSent": {
    "health_no_log": "2026-03-22T09:00:00.000Z",
    "tasks_pileup": null,
    "english_streak": "2026-03-21T09:30:00.000Z",
    "health_pattern": null,
    "tasks_great_day": null
  },

  "learnedFacts": [
    {
      "fact": "מעדיף תשובות קצרות וישירות",
      "confidence": 0.9,
      "source": "repeated short messages",
      "learnedAt": "2026-03-10T10:00:00.000Z"
    },
    {
      "fact": "עובד לרוב בשעות הערב (19:00-23:00)",
      "confidence": 0.75,
      "source": "message timestamps",
      "learnedAt": "2026-03-15T20:00:00.000Z"
    },
    {
      "fact": "כאב גבוה יותר בשישי",
      "confidence": 0.7,
      "source": "health log analysis",
      "learnedAt": "2026-03-20T09:00:00.000Z"
    }
  ]
}
```

---

## Memory Module — agent-memory.js

```javascript
'use strict';

const fs   = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'data', 'agent-memory.json');

const DEFAULT_MEMORY = {
  preferences: {
    language: 'he',
    responseLength: 'short',
    activeHoursStart: '08:00',
    activeHoursEnd: '22:00',
    preferredReminderLead: 15,
  },
  patterns: {
    healthReportTime: null,
    averagePainLevel: null,
    painSleepCorrelation: false,
    mostProductiveDays: [],
    averageTasksPerDay: 0,
    medicationAdherenceRate: null,
    englishPracticeRate: 0,
    pomodoroSessions: 0,
    lastActiveDate: null,
  },
  context: {
    currentProjects: [],
    openGoals: [],
    recentTopics: [],
    lastConversationSummary: null,
  },
  proactiveSent: {},
  learnedFacts: [],
};

function loadMemory(chatId) {
  try {
    const all = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return all[String(chatId)] || { ...DEFAULT_MEMORY };
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

function saveMemory(chatId, memory) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch {}
  all[String(chatId)] = { ...memory, lastUpdated: new Date().toISOString() };
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(all, null, 2), 'utf8');
}

function updateLastActive(chatId) {
  const memory = loadMemory(chatId);
  memory.patterns.lastActiveDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  saveMemory(chatId, memory);
}

function addRecentTopic(chatId, topic) {
  const memory = loadMemory(chatId);
  memory.context.recentTopics = [topic, ...(memory.context.recentTopics || [])].slice(0, 5);
  saveMemory(chatId, memory);
}

function updateLastConversation(chatId, summary) {
  const memory = loadMemory(chatId);
  memory.context.lastConversationSummary = summary;
  saveMemory(chatId, memory);
}

function formatMemoryBlock(memory) {
  const facts = (memory.learnedFacts || [])
    .filter(f => f.confidence > 0.6)
    .map(f => `• ${f.fact}`)
    .join('\n');

  const patterns = memory.patterns;
  const lines = [];

  if (patterns.averagePainLevel) lines.push(`ממוצע כאב: ${patterns.averagePainLevel}/10`);
  if (patterns.mostProductiveDays.length) lines.push(`ימים פרודוקטיביים: ${patterns.mostProductiveDays.join(', ')}`);
  if (patterns.healthReportTime) lines.push(`מדווח בריאות בדרך כלל ב: ${patterns.healthReportTime}`);
  if (memory.context.lastConversationSummary) lines.push(`שיחה אחרונה: ${memory.context.lastConversationSummary}`);

  if (!facts && !lines.length) return '[עדיין לא למדתי דפוסים אישיים — שיחה ראשונה]';

  return (lines.length ? lines.join('\n') + '\n' : '') + (facts ? 'עובדות שלמדתי:\n' + facts : '');
}

module.exports = { loadMemory, saveMemory, updateLastActive, addRecentTopic, updateLastConversation, formatMemoryBlock };
```

---

## What Gets Learned (Automatically)

### 1. Active Hours
- Track timestamps of user messages over 14 days
- Calculate median active window
- Update `preferences.activeHoursStart/End`

### 2. Health Report Time
- When user logs health, track the hour
- Average over 14 days
- Used by proactive: "usually logs at 20:00 — it's 21:00 and no log yet"

### 3. Average Pain Level
- Rolling 7-day average from health.json
- Triggers proactive if trending up

### 4. Pain/Sleep Correlation
- Compare health entries: pain score vs sleep hours
- Flag if Pearson correlation |r| > 0.5 over 14 days
- Used for insight messages

### 5. Most Productive Days
- Track which days most tasks are completed
- Store as array of Hebrew day names
- Used for weekly planning suggestions

### 6. Medication Adherence
- Ratio of taken/scheduled from medications.json
- Used in weekly summary and proactive nudges

### 7. English Practice Rate
- Count practice days per week from english-progress.json
- Used for streak proactive triggers

---

## Learning Algorithm

Run once per day during the daily analysis (scheduled at midnight IL):

```javascript
async function runDailyMemoryUpdate(chatId) {
  const memory = loadMemory(chatId);

  // 1. Pain average (last 7 days)
  const health7 = getRawWeekData(7);
  if (health7.length >= 3) {
    const avg = health7.reduce((s, e) => s + e.pain, 0) / health7.length;
    memory.patterns.averagePainLevel = Math.round(avg * 10) / 10;
  }

  // 2. Pain/sleep correlation
  if (health7.length >= 7) {
    const hasCorrelation = detectPainSleepCorrelation(health7);
    memory.patterns.painSleepCorrelation = hasCorrelation;
  }

  // 3. Most productive days (last 14 days)
  const tasks14 = getCompletedInRange(14);
  memory.patterns.mostProductiveDays = detectProductiveDays(tasks14);

  // 4. English practice rate (days per week)
  const progress = loadEnglishProgress();
  const recentDays = progress.dates?.filter(d => isWithinDays(d, 7)).length || 0;
  memory.patterns.englishPracticeRate = recentDays;

  saveMemory(chatId, memory);
}
```

---

## Memory Injection into System Prompt

```javascript
function buildSystemPrompt(memory) {
  const memoryBlock = formatMemoryBlock(memory);
  return BASE_SYSTEM_PROMPT
    .replace('{{CURRENT_DATETIME}}', nowIL())
    .replace('{{DAY_HEBREW}}', getDayHebrew())
    .replace('{{MEMORY_BLOCK}}', memoryBlock);
}
```

---

## Privacy Considerations

- All memory stored locally in `data/agent-memory.json` — no external services
- On Render: file is ephemeral (resets on deploy) — acceptable for MVP
- Future: could store in a simple KV store (e.g., Upstash Redis free tier) for persistence
- No sensitive health data stored in memory — only aggregates (averages, booleans)
- Raw health data stays in `data/health.json` as before

---

## Memory Size Control

- `learnedFacts`: capped at 20 entries (remove lowest confidence when full)
- `recentTopics`: rolling 5-item window
- Total memory file: < 10KB expected per user

---

## Render Ephemeral Storage Workaround

Since Render free tier loses files on redeploy, memory resets. Mitigation strategies:

**Option A (MVP):** Accept the reset — memory rebuilds in ~1 week of use
**Option B (Better):** Add memory backup to `data/` commit on startup (not feasible on Render)
**Option C (Best for Phase 3):** Use environment variable to store serialized memory (< 8KB fits in one env var)

```javascript
// On startup: restore memory from AGENT_MEMORY env var if data file missing
const memFromEnv = process.env.AGENT_MEMORY;
if (memFromEnv && !fs.existsSync(MEMORY_FILE)) {
  fs.writeFileSync(MEMORY_FILE, Buffer.from(memFromEnv, 'base64').toString('utf8'));
}

// Periodically: serialize and log the base64 (operator can set as env var)
```
