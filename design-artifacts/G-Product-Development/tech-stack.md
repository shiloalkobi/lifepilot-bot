# Tech Stack — LifePilot Bot

**Last updated:** March 2026

---

## Runtime & Deployment

| Layer | Choice | Reason |
|-------|--------|--------|
| Runtime | Node.js 18+ | Existing codebase, async I/O fits bot patterns |
| Deploy | Render (free tier) | Free, auto-deploy from GitHub, supports env vars |
| Process | Single process | Simple; no worker threads needed |
| HTTP server | Node.js `http` (built-in) | Render requires open port; no framework needed |

---

## AI / LLM

| Component | Choice | Reason |
|-----------|--------|--------|
| Model | Gemini 2.5 Flash | Free tier: 1,500 req/day; supports function calling |
| SDK | `@google/generative-ai` | Official Google SDK |
| Function calling | Native Gemini tool format | Calendar, Gmail, social drafts |
| System prompt | Inline + shilo_profile.md | Full context injected at startup |

---

## Telegram

| Component | Choice |
|-----------|--------|
| Bot API | `node-telegram-bot-api` v0.66 |
| Mode | Long polling (getUpdates) |
| Parse mode | HTML |

---

## Google Integrations

| Service | SDK | Auth |
|---------|-----|------|
| Google Calendar | `googleapis` v171 | OAuth2 token (google_token.json or GOOGLE_TOKEN_JSON env) |
| Gmail | `googleapis` v171 | Same OAuth2 token |

---

## Data Storage

| Data type | Storage | File |
|-----------|---------|------|
| Conversation history | In-memory (Map) | Resets on restart |
| Social drafts | JSON file | `data/drafts.json` |
| Tasks (planned) | JSON file | `data/tasks.json` |
| Health log (planned) | JSON file | `data/health.json` |
| Reminders (planned) | JSON file | `data/reminders.json` |
| Notes (planned) | JSON file | `data/notes.json` |

> **Note:** Render free tier has ephemeral filesystem — files reset on deploy. For persistent storage, use Render's persistent disk ($7/mo) or encode critical data in env vars.

---

## External APIs (Free)

| API | Use | Limit |
|-----|-----|-------|
| `www.oref.org.il` | Pikud HaOref alerts | Unlimited (polling) |
| OpenWeatherMap | Weather for morning briefing | 1,000 calls/day (free) |
| RSS feeds | Tech news (TheMarker, TechCrunch) | Unlimited |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
| `GEMINI_API_KEY` | ✅ | Google AI Studio key |
| `GROQ_API_KEY` | ✅ | (Legacy — kept for compatibility) |
| `ALERT_CHAT_ID` | ✅ | Telegram chat ID for Oref alerts |
| `GOOGLE_TOKEN_JSON` | Recommended | OAuth2 token JSON (stringified) for Calendar/Gmail |
| `PORT` | Auto (Render) | HTTP server port |
| `WP_SITES` | Optional | Comma-separated WordPress URLs to monitor |
| `OPENWEATHER_API_KEY` | Optional | For weather in morning briefing |
| `TEST_ALERT` | Dev only | Set to `1` to send mock Oref alert on startup |

---

## Package Dependencies

```json
{
  "@google/generative-ai": "^0.24.1",
  "dotenv": "^16.4.5",
  "googleapis": "^171.4.0",
  "node-telegram-bot-api": "^0.66.0",
  "openai": "^6.32.0"
}
```

> `groq-sdk` referenced in env but not in package.json — verify or remove.

---

## File Structure

```
shilobilo/
├── bot/
│   ├── index.js          — Entry point, HTTP server, startup
│   ├── telegram.js       — Bot polling, message routing
│   ├── claude.js         — Gemini AI + function calling
│   ├── google.js         — Calendar + Gmail integration
│   ├── oref.js           — Pikud HaOref alert monitor
│   ├── social.js         — Social media draft management
│   ├── history.js        — Conversation history (in-memory)
│   └── system_prompt.js  — (Unused — logic is in claude.js)
├── alerts/
│   └── oref.js           — Legacy standalone alert runner
├── data/                 — JSON storage (create if needed)
├── shilo_profile.md      — User profile injected into AI context
├── CLAUDE.md             — Claude Code project instructions
├── package.json
└── .env                  — Local secrets (never commit)
```
