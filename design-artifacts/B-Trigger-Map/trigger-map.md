# Trigger Map — LifePilot Bot

Maps user goals → psychological triggers → bot features.

---

## Core User Goals

| Goal | Pain Point | Trigger | Feature |
|------|-----------|---------|---------|
| Start day with clarity | Cognitive overload in the morning | Time (08:00) | Morning briefing |
| Stay on top of tasks | Forgetting things / mental load | User message | Task management |
| Manage CRPS | Hard to track patterns manually | User message + weekly cron | Health log |
| Learn English consistently | No daily habit formed yet | Time (09:00) | English practice |
| Avoid missing medication | Irregular timing with pain | User message + reminder | Medication log |
| Know if sites are down | Fear of missed downtime | Polling (5min) | WP monitor |
| Stay safe in emergencies | Real rocket threat in Israel | Alert API (1s) | Pikud HaOref |
| Review week's progress | Unclear sense of accomplishment | Time (Sunday 10:00) | Weekly summary |
| Capture quick ideas | Losing context when switching | User message | Notes/snippets |
| Focus during work sessions | Distraction, energy limitations | User message | Pomodoro |

---

## Trigger Types

### Time-based triggers
- 08:00 daily → Morning briefing
- 09:00 daily → English words
- 12:00 daily → News digest
- 21:00 daily → Evening summary
- Sunday 10:00 → Weekly summary + health report
- Every 30s → Reminder checker

### Event-based triggers
- User message → AI conversation
- Non-200 HTTP response → WP alert
- New oref.org.il alert ID → Security alert

### User-initiated triggers
- /start, /reset, /help, /morning, /english, /news, /summary, /weekly
- Natural language task/reminder/note creation
- "פומודורו X דקות"
- "לקחתי כדור"
- "כאב: N/10"
