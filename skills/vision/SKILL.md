# Skill: vision

Describes Telegram photos using the Gemini Vision API and passes the description to the agent so it can decide what to do (save as note, extract text, answer a question about the image, etc.).

## How it works

1. `telegram.js` detects `msg.photo` before the text handler runs.
2. It selects the largest photo variant (`msg.photo[msg.photo.length - 1]`).
3. Calls `bot.getFile()` to get the Telegram file path.
4. Builds the full download URL and calls `describeImage(fileUrl)` from this skill.
5. `describeImage` downloads the JPEG buffer and sends it to Gemini as `inline_data` with `mime_type: image/jpeg`.
6. The description (plus any user caption) is sent to `handleMessage()` so the agent can act on it.

## Agent tools

None — vision is intercepted at the transport layer, not inside the agent loop.

## Environment variables required

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Gemini API key (already set on Render) |

## Testing

Send any photo in Telegram (with or without a caption). The bot will describe the image and respond via the agent. Check logs for `[Skills] vision:` lines.
