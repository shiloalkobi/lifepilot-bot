# Skills Roadmap — LifePilot

Priority order for the next skills to build.
Each skill lives in `skills/<name>/` and is auto-loaded without touching `agent.js`.

---

## 1. voice — Voice Transcription

**What it does:** Receives Telegram voice messages (`.ogg`), transcribes them to text using Gemini Audio, then passes the text through the normal agent flow. Enables hands-free use.

**API:** Gemini 1.5 Flash / `gemini-2.0-flash-001` with `inlineData` audio input
(Alternatively: Groq Whisper `whisper-large-v3` — 1 hour free/day)

**Tokens per call:** ~300 tokens (short voice clip transcription)

**Dependencies:**
- Telegram `bot.on('voice')` handler in `telegram.js`
- Download voice file via `bot.getFile()` + fetch
- Pass to Gemini Audio API for transcription
- Forward transcript to `handleMessage()`

---

## 2. vision — Image Understanding

**What it does:** Receives photos sent to Telegram, analyzes them with Gemini Vision. Use cases: read a doctor's prescription, parse a receipt, describe a screenshot, read text from an image.

**API:** `gemini-2.0-flash-001` with `inlineData` image input (base64)

**Tokens per call:** ~500-1000 tokens depending on image complexity

**Dependencies:**
- Telegram `bot.on('photo')` handler in `telegram.js`
- Download photo via `bot.getFile()` + fetch
- Encode as base64 and send to Gemini multimodal API
- Return description/extracted text to user

---

## 3. web-search — Web Search

**What it does:** Searches the web and returns a summary. Useful for: current news, looking up a product, researching a topic.

**API (options):**
- DuckDuckGo Instant Answer API (free, no key) — limited
- SerpAPI free tier (100 searches/month)
- Brave Search API (2000 free/month)
- Tavily API (1000 free/month — best for AI agents)

**Tokens per call:** ~400-800 tokens (query + top 3 result summaries)

**Dependencies:**
- HTTP client (native `fetch` or `axios`)
- Optional: cheerio for HTML scraping fallback
- New tool: `web_search(query, maxResults)`

---

## 4. google-calendar-advanced — Advanced Calendar Features

**What it does:** Extends the existing calendar tools with: recurring events, attendees, reminders/notifications, availability checking, creating meeting links (Google Meet).

**API:** Google Calendar API v3 (already OAuth-authenticated via `bot/google.js`)

**Tokens per call:** ~200-400 tokens

**Dependencies:**
- Extends existing `bot/google.js` — NO new OAuth setup needed
- New tools: `add_calendar_attendee`, `set_recurring_event`, `check_availability`, `create_meet_link`
- Requires existing Google OAuth credentials to have `calendar.events` scope

---

## 5. gmail — Gmail Management

**What it does:** Beyond reading unread emails — compose and send replies, create drafts, search by sender/subject/date, label and archive messages.

**API:** Gmail API v1 (already OAuth-authenticated via `bot/google.js`)

**Tokens per call:** ~300-600 tokens (email content can be long — trim to 500 chars)

**Dependencies:**
- Extends existing `bot/google.js` — NO new OAuth setup needed
- New tools: `send_email`, `reply_email`, `search_emails`, `archive_email`, `get_email_thread`
- Must sanitize HTML email bodies before sending to LLM

---

## 6. expenses — Expense Tracking

**What it does:** Log daily expenses, categorize automatically (food, transport, health, tech), view monthly totals, set budget alerts.

**API:** None — local JSON file (`data/expenses.json`)

**Tokens per call:** ~150-250 tokens

**Dependencies:**
- New data file: `data/expenses.json`
- New module: `bot/expenses.js`
- New tools: `log_expense(amount, category, note)`, `get_expenses(month)`, `get_expense_summary()`, `set_budget(category, limit)`
- Categories: food, transport, health, tech, entertainment, other

---

## 7. charts — Chart Generation

**What it does:** Generates visual charts from health data, tasks, or expenses and sends them as images to Telegram. E.g. "pain levels this week", "task completion rate", "expenses by category".

**API:** `chartjs-node-canvas` (npm package, server-side Chart.js rendering)

**Tokens per call:** ~200 tokens (chart config generation) + 0 for rendering (local)

**Dependencies:**
- `npm install chartjs-node-canvas` (adds ~15MB to bundle)
- New module: `bot/charts.js`
- New tools: `generate_health_chart(days)`, `generate_task_chart(days)`, `generate_expense_chart(month)`
- Output: PNG buffer → `bot.sendPhoto(chatId, buffer)`
- Note: Render free tier (512MB RAM) — chart rendering is memory-heavy, test carefully

---

## 8. proactive — Scheduled Nudges

**What it does:** Implements the 10 proactive trigger rules from `design-artifacts/agent/agent-proactive.md`. Analyzes health/tasks/habits data daily and sends smart nudges when patterns suggest the user needs support.

**API:** Groq/Gemini for generating the nudge message text (~100 tokens each)

**Tokens per call:** ~300 tokens (context analysis + nudge generation)

**Dependencies:**
- New module: `bot/agent-proactive.js` (skeleton exists in design-artifacts)
- Integrate with `scheduler.js` (daily cron at 08:00)
- Reads: `data/health.json`, `data/tasks.json`, `data/medications.json`, `data/agent-memory.json`
- Cooldown tracking in `data/agent-memory.json` under `proactiveSent`
- Anti-spam: max 2 messages/day, only 08:00-21:00 IL, skip if user active last 2h

**10 Triggers:**
1. No health log for 2+ days
2. Pain ≥7 for 3+ consecutive days
3. 8+ open tasks + 0 completed in 3 days
4. 5+ tasks completed today (positive acknowledgment)
5. 3 days no English practice
6. Medication overdue 4+ hours
7. Pain/sleep correlation detected
8. Friday momentum check (13:00)
9. Site down for 30+ min (already via sites.js)
10. Oref alert follow-up (already via oref.js)

---

## 9. smart-memory — Pattern Analysis

**What it does:** Learns from accumulated health/task/habit data. Detects correlations (e.g., pain spikes on low-sleep nights), identifies productive patterns (which days/times work best), updates the memory block that's injected into the system prompt.

**API:** Groq/Gemini for pattern summarization (~500 tokens/run)

**Tokens per call:** ~500-800 tokens (weekly analysis)

**Dependencies:**
- Extends existing `bot/agent-memory.js`
- New function: `runDailyMemoryUpdate(chatId)` — called at midnight by scheduler
- Algorithms: 7-day rolling averages, Pearson correlation (pain vs sleep), task velocity
- Stores results in `data/agent-memory.json`
- Injects learned facts into system prompt via `formatMemoryBlock()`
- Note: Render ephemeral storage — memory resets on redeploy (acceptable for MVP)

---

## Token Budget Reference

| Skill | Tokens/call | Calls/day est. | Daily cost |
|-------|-------------|----------------|------------|
| voice | ~300 | 3 | ~900 |
| vision | ~700 | 2 | ~1400 |
| web-search | ~600 | 5 | ~3000 |
| gmail | ~450 | 3 | ~1350 |
| expenses | ~200 | 5 | ~1000 |
| charts | ~200 | 2 | ~400 |
| proactive | ~300 | 2 | ~600 |
| smart-memory | ~650 | 1 (cron) | ~650 |

Current base agent: ~800 tokens/call × 40 calls/day = ~32000/day
Total with all skills: ~32000 + ~9300 = ~41300/day (well within Groq 100K limit)
