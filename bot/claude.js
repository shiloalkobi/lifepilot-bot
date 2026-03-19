'use strict';

const Groq = require('groq-sdk');
const { loadSystemPrompt } = require('./system_prompt');
const {
  getCalendarEvents,
  createCalendarEvent,
  getUnreadEmails,
  findEventsByQuery,
  updateCalendarEvent,
  deleteCalendarEvent,
} = require('./google');

const client       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const systemPrompt = loadSystemPrompt();

const googleReady = (() => {
  if (process.env.GOOGLE_TOKEN_JSON) { console.log('[Google] using env var token'); return true; }
  try { require('fs').readFileSync(require('path').join(__dirname, '..', 'google_token.json')); console.log('[Google] using file token'); return true; }
  catch { console.log('[Google] no token found — disabled'); return false; }
})();

// ── Intent classification via JSON mode ────────────────────────────────────────
const INTENT_SYSTEM = `You are an intent classifier for a Hebrew/English personal assistant.
Today's date and time (Asia/Jerusalem): {NOW}

Respond ONLY with valid JSON, no extra text.

Classify the user message into one of these intents and extract parameters:

- "read_calendar": user wants to see/list calendar events
  params: { "days": number (1=today, 2=tomorrow, 7=this week) }

- "create_event": user wants to add/create a new calendar event
  params: { "summary": string, "startDateTime": "YYYY-MM-DDTHH:MM:SS", "endDateTime": "YYYY-MM-DDTHH:MM:SS" }
  Note: if no end time given, add 1 hour to start. Use the CURRENT YEAR unless user specifies otherwise.

- "update_event": user wants to rename/reschedule/change an existing event
  params: { "search": "event name to find", "updates": { "summary"?: string, "startDateTime"?: "YYYY-MM-DDTHH:MM:SS", "endDateTime"?: "YYYY-MM-DDTHH:MM:SS" } }

- "delete_event": user wants to remove/cancel an event
  params: { "search": "event name to find" }

- "read_emails": user wants to see unread emails
  params: { "maxResults": number }

- "chat": anything else (general questions, conversation, etc.)
  params: {}

Return format:
{ "intent": "<intent>", "params": { ... } }`;

async function classifyIntent(userMessage) {
  const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const prompt = INTENT_SYSTEM.replace('{NOW}', now);

  const res = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 300,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userMessage },
    ],
  });

  return JSON.parse(res.choices[0].message.content);
}

// ── Execute Google action and return result string ─────────────────────────────
async function executeGoogleAction(intent, params) {
  if (intent === 'read_calendar') {
    return await getCalendarEvents(Number(params.days) || 1);
  }

  if (intent === 'create_event') {
    return await createCalendarEvent(params.summary, params.startDateTime, params.endDateTime);
  }

  if (intent === 'update_event') {
    const found = JSON.parse(await findEventsByQuery(params.search || ''));
    if (!found.found) return found.message;
    const event = found.events[0];
    return await updateCalendarEvent(event.id, params.updates || {});
  }

  if (intent === 'delete_event') {
    const found = JSON.parse(await findEventsByQuery(params.search || ''));
    if (!found.found) return found.message;
    return await deleteCalendarEvent(found.events[0].id);
  }

  if (intent === 'read_emails') {
    return await getUnreadEmails(Number(params.maxResults) || 5);
  }

  return null;
}

// ── Final response from model ──────────────────────────────────────────────────
async function generateResponse(messages, googleData) {
  const extra = googleData
    ? [{ role: 'assistant', content: `[נתוני Google]\n${googleData}` }]
    : [];

  const res = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
      ...extra,
    ],
  });

  return res.choices[0].message.content || '(no response)';
}

// ── Main entry ─────────────────────────────────────────────────────────────────
async function askClaude(messages) {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  if (googleReady) {
    try {
      const { intent, params } = await classifyIntent(lastUserMessage);
      console.log('[Intent]', intent, params);

      if (intent !== 'chat') {
        const googleData = await executeGoogleAction(intent, params || {});
        return await generateResponse(messages, googleData);
      }
    } catch (err) {
      console.error('[Intent/Google error]', err.message);
      // Fall through to regular chat on error
    }
  }

  return await generateResponse(messages, null);
}

module.exports = { askClaude };
