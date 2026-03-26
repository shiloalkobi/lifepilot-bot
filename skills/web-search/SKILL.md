# Skill: web-search

Lets the agent search the web and return the top 5 results with title, snippet, and URL.

## Agent tool

| Tool | Parameters | Description |
|------|-----------|-------------|
| `web_search` | `query` (string) | Search the web, return top 5 results |

## Sources (in priority order)

| Source | Requires | Limit |
|--------|----------|-------|
| Tavily API | `TAVILY_API_KEY` env var | 1,000 searches/month free |
| DuckDuckGo Instant Answer | Nothing | Unlimited, but limited results |

If `TAVILY_API_KEY` is set, Tavily is used. If it's missing or fails, falls back to DuckDuckGo automatically.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TAVILY_API_KEY` | Optional | Get free key at https://tavily.com |

## Output format

```
🔍 search query

1. Title — short snippet
   https://example.com
2. ...
```

Kept short to minimize token usage.

## Testing

Ask the agent: `תחפש מה זה gemini-3-flash-preview` or `search for Claude Code latest features`.
Check logs for `[Skills] web-search:` lines.
