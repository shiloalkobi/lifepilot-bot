# Agent Implementation Plan

**Version:** 1.0
**Date:** 2026-03-24
**Status:** Planning

---

## Overview

Transform LifePilot from command-bot to AI Agent in **5 phases**.
Each phase is independently deployable — no phase breaks existing functionality.

Total estimated implementation work: ~4-6 focused sessions

---

## Phase 1 — Core Agent Loop (MVP)

**Goal:** Natural language understanding + basic tool calling
**Time estimate:** 1 session (~3-4 hours)
**Risk:** Low — all slash commands remain unchanged

### Files to create:
- `bot/agent.js` — ReAct loop
- `bot/agent-tools.js` — 20 core tool definitions + handlers
- `bot/agent-memory.js` — load/save skeleton (no learning yet)

### Files to modify:
- `bot/telegram.js` — route non-command messages to `agent.handleMessage()`
- `bot/health.js` — add `logDirect({ pain, mood, sleep, symptoms, notes })`
- `bot/reminders.js` — add `addReminderDirect(chatId, task, remindAtISO)`

### What works after Phase 1:
- "יש לי כאב ראש" → agent calls `log_health({ pain: 7 })`
- "תוסיף משימה לכתוב README" → agent calls `add_task`
- "מה יש לי לעשות?" → agent reads tasks, responds naturally
- "תזכיר לי לאכול ב-13:00" → agent calculates time, calls `add_reminder`
- All `/slash` commands still work exactly as before

### What does NOT work yet:
- Memory/learning (skeleton only)
- Proactive messages
- Multi-step chaining (depth limited to 1)
- Image/voice/web

### Implementation checklist:
- [ ] Create `bot/agent.js` with `handleMessage(bot, chatId, text)`
- [ ] Create `bot/agent-tools.js` with `TOOL_DEFINITIONS` array + `executeTool()`
- [ ] Create `bot/agent-memory.js` with `loadMemory()` / `saveMemory()` (defaults only)
- [ ] Add `health.logDirect()` function to `bot/health.js`
- [ ] Add `reminders.addReminderDirect()` to `bot/reminders.js`
- [ ] Modify `bot/telegram.js`: add stateful-flow check, then route to `agent.handleMessage()`
- [ ] Add `buildSystemPrompt(memory)` to agent (static, no memory injection yet)
- [ ] Test: 10 natural language messages covering all tool categories
- [ ] Deploy to Render + smoke test

---

## Phase 2 — Multi-Tool Chaining + Full Tool Coverage

**Goal:** Agent can handle complex requests needing 2-3 tools
**Time estimate:** 1 session (~2-3 hours)
**Risk:** Low

### Files to modify:
- `bot/agent.js` — enable ReAct loop up to depth 3
- `bot/agent-tools.js` — add remaining 7 tools (calendar, web fetch, context)

### New tools added:
- `get_current_context` — returns summary of today's state
- `fetch_web_page` — fetches URL, returns text
- `get_calendar_events` — reads Google Calendar
- `create_calendar_event` — writes to Google Calendar
- `get_health_summary` — trend data (not just today)
- `start_pomodoro` / `stop_pomodoro` with bot context

### What works after Phase 2:
- "יש לי כאב ראש, תזכיר לי לקחת אקמול בעוד שעה" → 2 tool calls
- "מה המצב שלי היום?" → get_current_context + respond
- "תסכם לי את המאמר הזה: [URL]" → fetch_web_page + summarize
- "מה יש לי מחר ביומן?" → get_calendar_events
- "תוסיף לי פגישה ב-14:00" → create_calendar_event

### Implementation checklist:
- [ ] Enable depth-3 ReAct loop in `bot/agent.js`
- [ ] Add `buildCurrentContext(chatId)` function
- [ ] Add `fetchWebPage(url)` function (Node.js https, 3000 char limit)
- [ ] Add remaining Google Calendar tools
- [ ] Test: 5 multi-tool scenarios
- [ ] Deploy + test

---

## Phase 3 — Memory + Learning

**Goal:** Agent remembers patterns and preferences
**Time estimate:** 1 session (~3 hours)
**Risk:** Medium (file system changes)

### Files to create:
- `bot/agent-proactive.js` — proactive trigger system

### Files to modify:
- `bot/agent-memory.js` — add `runDailyMemoryUpdate()`, `formatMemoryBlock()`
- `bot/agent.js` — inject memory into system prompt
- `bot/scheduler.js` — add daily memory update cron (midnight IL)
- `bot/scheduler.js` — add proactive checks cron (09:00 IL)
- `bot/index.js` — `require('./agent-proactive')` + wire cron

### What works after Phase 3:
- Agent knows user's average pain level, active hours, productive days
- Pain/sleep correlation detected and mentioned in insights
- Proactive: "2 ימים בלי דיווח בריאות"
- Proactive: "7 משימות פתוחות"
- Proactive: "3 ימים בלי אנגלית"
- Memory persists across conversations (same session — Render ephemeral caveat)

### Implementation checklist:
- [ ] Implement `runDailyMemoryUpdate(chatId)` in `bot/agent-memory.js`
- [ ] Implement `formatMemoryBlock(memory)` for system prompt injection
- [ ] Add memory injection to `buildSystemPrompt()` in `bot/agent.js`
- [ ] Create `bot/agent-proactive.js` with 5 trigger checks
- [ ] Add proactive cron to `bot/scheduler.js`
- [ ] Test: wait 2 days to verify proactive message fires
- [ ] Test: memory block appears in Gemini context (log it)
- [ ] Deploy + test

---

## Phase 4 — Advanced I/O (Image + Voice)

**Goal:** Agent handles photos and voice messages
**Time estimate:** 1 session (~2-3 hours)
**Risk:** Medium (new Telegram API features)

### Files to create:
- `bot/agent-media.js` — image and voice handlers

### Files to modify:
- `bot/telegram.js` — add `bot.on('photo', ...)` and `bot.on('voice', ...)` handlers
- `bot/agent.js` — pass image/audio data to Gemini

### How it works:

**Image:**
```javascript
bot.on('photo', async (msg) => {
  const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
  const filePath = await bot.getFileLink(fileId);
  // Download to tmp file
  // Pass as inline_data to Gemini (base64 JPG)
  // Ask: "What's in this image? How can I help Shilo with it?"
});
```

**Voice:**
```javascript
bot.on('voice', async (msg) => {
  const fileId = msg.voice.file_id;
  const filePath = await bot.getFileLink(fileId);
  // Download OGG file
  // Pass to Gemini Audio API as inline_data
  // Gemini transcribes + understands intent
  // Feed text to agent as if typed
});
```

### What works after Phase 4:
- Send photo of receipt → agent extracts amount, suggests saving as note
- Send voice note "תוסיף משימה לסיים את הפרויקט" → agent transcribes + calls add_task
- Send screenshot → agent describes content, offers to save as note
- Send photo of whiteboard → agent reads text

### Implementation checklist:
- [ ] Add `bot.on('photo', ...)` handler in `bot/telegram.js`
- [ ] Add `bot.on('voice', ...)` handler in `bot/telegram.js`
- [ ] Create `bot/agent-media.js` with `handlePhoto()` and `handleVoice()`
- [ ] Test: send 3 test photos
- [ ] Test: send 3 test voice messages
- [ ] Deploy + test

---

## Phase 5 — Charts + Multi-step Workflows

**Goal:** Visual data + complex autonomous workflows
**Time estimate:** 1-2 sessions (~4-6 hours)
**Risk:** Medium-High (new npm dependency)

### New npm dependency:
```
npm install chartjs-node-canvas
```

### Files to create:
- `bot/charts.js` — PNG chart generation

### New tools:
- `generate_chart({ type, data, title })` → returns PNG buffer
- Agent sends via `bot.sendPhoto(chatId, buffer)`

### Chart types:
- Line chart: pain/mood/sleep over time
- Bar chart: tasks completed by day/week
- Progress chart: medication adherence, English streak

### Multi-step Workflows:
No new infrastructure needed — agent already chains tools.
Add these workflow prompts to the system prompt:

```
WORKFLOW — "תכנן לי את השבוע":
1. Call get_calendar_events(7)
2. Call get_tasks()
3. Call get_health_summary(7) to see energy trend
4. Synthesize: create 3 task priorities for the week
5. Optionally: call add_task for each priority

WORKFLOW — "עזור לי להתחיל להתאמן":
1. Call get_health_today() for current pain level
2. If pain < 5: suggest 3 beginner exercises for CRPS
3. Call add_reminder for exercise time
4. Call add_task("יום ראשון להתאמנות")
```

### Implementation checklist:
- [ ] Install `chartjs-node-canvas`
- [ ] Create `bot/charts.js` with `generateLineChart()`, `generateBarChart()`
- [ ] Add `generate_chart` to `bot/agent-tools.js`
- [ ] Test chart generation (save PNG locally first)
- [ ] Add `bot.sendPhoto()` support to agent response handler
- [ ] Test: "הראה לי גרף כאב השבוע"
- [ ] Add workflow prompts to system prompt
- [ ] Test: "תכנן לי את השבוע"
- [ ] Deploy + test

---

## Rollout Order

```
Phase 1 (MVP)     → Deploy, use for 1 week, verify no regressions
Phase 2 (Chains)  → Deploy, test complex requests
Phase 3 (Memory)  → Deploy, verify proactive messages in ~2 days
Phase 4 (Media)   → Deploy, test photo/voice
Phase 5 (Charts)  → Deploy, test visual outputs
```

---

## Testing Plan Per Phase

### Phase 1 Tests:
```
1. "יש לי כאב 6"
   Expected: calls log_health({ pain: 6 }), confirms

2. "תוסיף משימה לבדוק GitHub issues"
   Expected: calls add_task, confirms with task number

3. "מה יש לי לעשות?"
   Expected: calls get_tasks, lists in Hebrew

4. "סיימתי את משימה 2"
   Expected: calls complete_task({ task_index: 2 })

5. "תזכיר לי לאכול בעוד 2 שעות"
   Expected: calls add_reminder with correct time

6. "שמור הערה: PORT ב-Render הוא תמיד 3000"
   Expected: calls save_note

7. "מה המילה האנגלית היום?"
   Expected: calls get_daily_word, formats nicely

8. "בוא נתחיל פומודורו"
   Expected: calls start_pomodoro(25)

9. "תראה לי חדשות"
   Expected: calls get_tech_news

10. "לקחתי אקמול"
    Expected: calls mark_med_taken({ medication_name: "אקמול" })
```

### Phase 2 Tests:
```
1. "יש לי כאב ראש, תזכיר לי לקחת אקמול בעוד שעה"
   Expected: 2 tool calls — log_health + add_reminder

2. "איך אני עומד היום?"
   Expected: get_current_context → comprehensive response

3. "תסכם לי את https://example.com"
   Expected: fetch_web_page → summary
```

---

## Backward Compatibility Guarantee

**All existing `/slash` commands remain 100% functional.**

The agent only handles messages that:
1. Don't start with `/`
2. Are not in the middle of a health check-in
3. Are not in the middle of an English quiz

This means zero regression risk for Phase 1-3.

---

## Resource Budget (Phase 1-3)

| Source | Daily API calls |
|--------|----------------|
| User conversations (est. 20 msgs × avg 2 calls) | 40 |
| Cron summaries (morning context, news, daily, weekly) | 5 |
| Proactive messages (max 2/day) | 2 |
| Memory update (once nightly) | 0 (no API call) |
| **Total** | **~47 calls/day** |

Remaining headroom: **~53 calls/day** — plenty of buffer within 100/day limit.

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Rate limit exceeded | Medium | Proactive budget cap, fallback messages without API |
| Gemini tool calling fails | Low | Wrap in try/catch, return graceful Hebrew error |
| State machine conflicts (health/quiz) | Low | Check isInCheckin/isInQuiz before routing to agent |
| Memory file lost on Render redeploy | High | Accept for MVP; Phase 3 adds env var backup |
| Latency too high (3 tool calls) | Medium | Parallel tool execution where possible |
| Agent hallucinates tool parameters | Low | Strict Gemini prompt rules + parameter validation |
