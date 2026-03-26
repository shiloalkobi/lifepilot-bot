# Skill: voice

Transcribes Telegram voice messages using the Gemini Audio API and routes the transcription through the normal agent pipeline.

## How it works

1. `telegram.js` detects `msg.voice` before the text handler runs.
2. It calls `bot.getFile()` to get the Telegram file path.
3. Builds the full download URL and calls `transcribeVoice(fileUrl)` from this skill.
4. `transcribeVoice` downloads the `.ogg` buffer and sends it to Gemini as `inline_data` with `mime_type: audio/ogg`.
5. The returned transcript is passed to `handleMessage()` as if the user typed it.

## Agent tools

None — voice is intercepted at the transport layer, not inside the agent loop.

## Environment variables required

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Gemini API key (already set on Render) |

## Testing

Send any voice message in Telegram. The bot will reply with the agent's response to the transcribed text. Check logs for `[Skills] voice:` lines.
