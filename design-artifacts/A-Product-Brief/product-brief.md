# Product Brief — LifePilot Bot

**Version:** 1.0
**Date:** March 2026
**Owner:** שילה אלקובי

---

## What is LifePilot?

LifePilot is a personal Telegram bot for Shilo Alkobi — a single conversational interface that replaces scattered apps and tools. It acts as a smart daily assistant that knows everything about Shilo (health, projects, schedule) and proactively helps manage energy, tasks, and learning.

---

## The Problem

Shilo manages multiple contexts simultaneously:
- Chronic pain (CRPS) requiring daily tracking and energy management
- 6+ active dev projects with no unified tracking
- Calendar + Gmail access needed on the go
- Security alerts (Pikud HaOref) critical for safety
- English learning goal with no daily routine
- WordPress sites that need uptime monitoring

No single tool handles all of this. Switching between apps costs energy — a premium resource given the health situation.

---

## The Solution

One Telegram bot. Natural Hebrew conversation. Everything in one place.

- **Knows Shilo** — full profile loaded into AI context
- **Proactive** — sends morning briefings, reminders, health prompts
- **Integrated** — Google Calendar, Gmail, Pikud HaOref alerts
- **Extensible** — new capabilities added as Node.js modules

---

## Target User

**Shilo Alkobi** — solo developer, Israel, CRPS patient since 2018.

Key constraints:
- Energy-limited: needs minimal friction
- Tech-savvy: comfortable with bots, APIs, automation
- Self-directed learner: wants tools that grow with him

---

## Core Value Propositions

1. **Zero-friction daily management** — one message replaces 5 app opens
2. **Health-aware** — tracks CRPS pain, medications, treatment logs
3. **Safety** — real-time Pikud HaOref alerts (1s polling)
4. **Learning** — daily English practice built into the routine
5. **Project visibility** — all active projects tracked in one place

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Daily active use | 1+ conversations/day |
| Morning briefing delivery | 08:00 ±2min, 7 days/week |
| Alert latency (Pikud HaOref) | < 3 seconds |
| Health log entries/week | ≥ 5 |
| English words practiced/week | ≥ 50 |

---

## Constraints

- **Free/low-cost only** — Render free tier, Gemini free tier (1,500 req/day)
- **Node.js only** — no Python services
- **Telegram only** — no web UI needed
- **No database** — JSON file storage acceptable for MVP
- **Deployed on Render** — must listen on PORT env var
