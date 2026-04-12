# Skill: ai-news

Fetches top AI / Claude Code news stories of the day from Hacker News and Simon Willison's blog.

## Agent tool

| Tool | Description |
|------|-------------|
| `get_ai_news` | Returns top 5 AI/Claude Code stories (title + link + source) |

## Sources

| Source | Method |
|--------|--------|
| Hacker News | Algolia search API — query: `Claude OR Anthropic OR "AI agent" OR LLM`, last 48 h |
| Simon Willison | Atom feed — `simonwillison.net/atom/everything/` |

## Cron

`index.js` schedules a daily send at **08:30 Israel time** to chat `758752313`.
Format: title + link + source, max 5 stories, HTML parse mode.

## Environment variables required

None beyond what's already set (no external API key needed — HN Algolia and Simon Willison are public).

## Testing

Ask the agent: `what's the AI news today?` — it will call `get_ai_news`.
Or wait for the daily 08:30 push.
Check logs for `[Skills] ai-news:` lines.
