# Agent Architecture — LifePilot AI Agent Layer

**Version:** 1.0
**Date:** 2026-03-24
**Status:** Planning

---

## Overview

Transform LifePilot from a command-based bot into an AI Agent that understands natural language, reasons about intent, selects tools autonomously, and responds conversationally in Hebrew.

The agent layer is a **thin middleware** sitting between Telegram messages and existing modules — it adds intelligence without replacing anything.

---

## Architecture Diagram

```
User message (Telegram)
        │
        ▼
┌─────────────────────────────────────┐
│         bot/telegram.js             │
│  (still handles /slash commands)    │
│  Non-command text → agent.js        │
└──────────────┬──────────────────────┘
               │ plain text messages
               ▼
┌─────────────────────────────────────┐
│           bot/agent.js              │  ← NEW
│                                     │
│  1. Load context (memory + history) │
│  2. Build prompt + tool definitions │
│  3. Call Gemini with function calling│
│  4. Execute tool call(s)            │
│  5. Feed results back to Gemini     │
│  6. Return natural language reply   │
└──────┬──────────────────────────────┘
       │ calls
       ▼
┌─────────────────────────────────────┐
│         Existing Modules            │
│  tasks · health · medications       │
│  reminders · notes · english        │
│  pomodoro · news · sites · google   │
│  weather · social                   │
└─────────────────────────────────────┘
```

---

## ReAct Pattern (Reason + Act)

The agent uses the **ReAct** pattern: each turn, Gemini reasons about intent, selects tools, acts, observes results, and reasons again if needed.

```
Turn flow:
  REASON:  "User says 'יש לי כאב ראש ולא לקחתי אקמול'
            → Intent: log health (high pain) + check meds + maybe add reminder
            → Tools needed: health.getTodayHealth, medications.getTodayMedStatus"

  ACT:     Call getTodayHealth() → { pain: null (no entry today) }
            Call getTodayMedStatus() → [{ name: 'Acamol', status: 'pending' }]

  OBSERVE: Pain not logged yet. Acamol is pending.

  REASON:  "Should log pain, remind about Acamol, offer to set reminder"

  ACT:     Call health.logEntry({ pain: 8, ... }) or return structured reply
            asking user for full check-in

  RESPOND: "רשמתי — כאב ראש. אקמול עוד לא לקחת היום.
            רוצה שאזכיר לך בעוד חצי שעה?"
```

**Maximum tool chain depth:** 3 iterations (to stay within rate limits and latency targets)

---

## File Structure

```
bot/
├── agent.js          ← NEW: main agent loop
├── agent-memory.js   ← NEW: load/save agent-memory.json
├── agent-tools.js    ← NEW: tool definitions for Gemini function calling
├── telegram.js       ← MODIFIED: route non-commands to agent
└── ...existing modules...

data/
└── agent-memory.json ← NEW: persistent memory
```

---

## agent.js — Core Logic

```javascript
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { canCall, increment } = require('./rate-limiter');
const { getHistory, addMessage } = require('./history');
const { loadMemory } = require('./agent-memory');
const { TOOL_DEFINITIONS, executeTool } = require('./agent-tools');
const { buildSystemPrompt } = require('./agent-prompts');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function handleMessage(bot, chatId, text) {
  if (!canCall()) {
    return '⚠️ הגעתי ל-100 קריאות API היום. נסה שוב מחר.';
  }
  increment();

  const memory   = loadMemory(chatId);
  const history  = getHistory(chatId);
  const sysPrompt = buildSystemPrompt(memory);

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: sysPrompt,
    tools: [{ functionDeclarations: TOOL_DEFINITIONS }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  });

  const chat = model.startChat({ history });
  addMessage(chatId, 'user', text);

  let response = await chat.sendMessage(text);
  let reply    = null;
  let depth    = 0;

  // ReAct loop: execute tools until model returns text
  while (depth < 3) {
    const candidate = response.response.candidates[0];
    const parts     = candidate.content.parts;
    const funcCalls = parts.filter(p => p.functionCall);

    if (funcCalls.length === 0) {
      // Model returned text → done
      reply = parts.map(p => p.text || '').join('').trim();
      break;
    }

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      funcCalls.map(async (part) => {
        const { name, args } = part.functionCall;
        const result = await executeTool(name, args, { bot, chatId });
        return { functionResponse: { name, response: { result } } };
      })
    );

    // Feed results back to Gemini
    if (canCall()) {
      increment();
      response = await chat.sendMessage(toolResults);
    } else {
      reply = '⚠️ הגבלת API — לא הצלחתי לסיים את הפעולה.';
      break;
    }
    depth++;
  }

  if (!reply) reply = 'אירעה שגיאה, נסה שוב.';

  addMessage(chatId, 'model', reply);
  return reply;
}

module.exports = { handleMessage };
```

---

## telegram.js — Integration Point

The only change to `telegram.js`: the catch-all handler at the bottom routes to `agent.js` instead of `claude.js`:

```javascript
// BEFORE (current):
bot.on('message', async (msg) => {
  // ... existing command handlers above ...
  const reply = await askClaude(messages);
  bot.sendMessage(chatId, reply);
});

// AFTER (agent):
const { handleMessage } = require('./agent');

bot.on('message', async (msg) => {
  // All /slash commands remain unchanged above
  // Non-command text falls through to agent:
  if (!msg.text || msg.text.startsWith('/')) return;

  const reply = await handleMessage(bot, chatId, msg.text);
  bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
});
```

**All `/slash` commands continue to work as before** — zero regression.

---

## Stateful Interactions

Some modules use state machines (health check-in, English quiz). The agent must respect these:

```javascript
// In agent.js, before calling Gemini:
const { isInCheckin } = require('./health');
const { isInQuiz }    = require('./english');

if (isInCheckin(chatId)) {
  // Route to health module directly, don't use agent
  return health.processCheckinStep(chatId, text);
}
if (isInQuiz(chatId)) {
  return english.processQuizAnswer(chatId, text);
}
```

This prevents the agent from intercepting mid-flow state machine responses.

---

## Multi-Tool Chaining Example

**User:** "יש לי כאב ראש, תזכיר לי לקחת אקמול בעוד שעה"

```
Gemini REASON: Two intents → health log + reminder
Gemini ACT:    [
  functionCall: health_log_pain({ pain: 7, notes: "כאב ראש" }),
  functionCall: add_reminder({ task: "לקחת אקמול", in_minutes: 60 })
]
executeTool("health_log_pain") → "נרשם: כאב 7/10"
executeTool("add_reminder")    → "תזכורת נקבעה ל-19:47"

Gemini RESPOND: "רשמתי כאב ראש (7/10) ✅
                תזכורת לאקמול נקבעה ל-19:47 ⏰"
```

---

## Rate Limiting Strategy

With 100 calls/day and an agent that uses 1-3 calls per message:

| Action | Cost |
|--------|------|
| Simple factual reply (no tools) | 1 call |
| Single tool call + response | 2 calls |
| Multi-tool chain (2 iterations) | 3 calls |
| Proactive message (daily) | 1 call |
| Cron summaries (daily/weekly) | 1 call each |

**Budget allocation:**
- User conversations: ~60 calls/day (20-30 messages × 2-3 calls)
- Cron jobs: 5 calls/day (morning/english/news/summary/weekly)
- Proactive checks: 5 calls/day
- Reserve: 30 calls/day

**Fallback:** If `!canCall()`, respond with canned Hebrew message without API call.

---

## Error Handling

```javascript
// Tool execution errors are caught and returned as strings
async function executeTool(name, args, ctx) {
  try {
    return await TOOL_HANDLERS[name](args, ctx);
  } catch (err) {
    console.error(`[Agent] Tool ${name} failed:`, err.message);
    return { error: err.message };
  }
}

// Gemini errors
try {
  response = await chat.sendMessage(text);
} catch (err) {
  // Quota exceeded, network error, etc.
  return 'סליחה, לא הצלחתי לעבד את ההודעה. נסה שוב.';
}
```

---

## Advanced Capabilities (Future Phases)

### Image Understanding (Phase 4)
- User sends photo → Telegram provides `file_id`
- Download via bot API → pass to Gemini Vision
- Agent describes/analyzes: receipts, screenshots, medical documents
- Tool: `analyze_image({ file_id })`

### Voice Messages (Phase 4)
- User sends voice → Telegram provides `file_id` (OGG/OPUS)
- Download → pass audio bytes to Gemini Audio API
- Returns transcription → feed into agent as text
- Tool: `transcribe_voice({ file_id })`

### Web Browsing (Phase 3)
- Agent fetches URL and extracts text
- Pass to Gemini for summarization
- Tool: `fetch_url({ url, max_chars: 3000 })`

### Google Calendar Integration (Already exists via google.js)
- Tools: `get_calendar_events`, `create_calendar_event`, etc.
- Already implemented in claude.js — just needs wrapping in agent tools

### Chart Generation (Phase 5)
- Node.js `canvas` or `chartjs-node-canvas` package
- Generate PNG charts of health/productivity data
- Send via `bot.sendPhoto(chatId, buffer)`
- Tool: `generate_chart({ type, data, title })`

### Multi-step Workflows (Phase 4)
- "תכנן לי את השבוע" → agent reads calendar + tasks + reminders → creates structured plan
- Agent can execute a sequence of write operations (add tasks, create reminders)
- No new infrastructure needed — just multi-call chains
