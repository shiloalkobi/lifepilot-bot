'use strict';

const OpenAI = require('openai');
const { loadSystemPrompt } = require('./system_prompt');
const {
  getCalendarEvents,
  createCalendarEvent,
  getUnreadEmails,
  findEventsByQuery,
  updateCalendarEvent,
  deleteCalendarEvent,
} = require('./google');

// Gemini 2.5 Flash via OpenAI-compatible endpoint
const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

const MODEL = 'gemini-2.5-flash';

const systemPrompt = loadSystemPrompt();

const googleReady = (() => {
  if (process.env.GOOGLE_TOKEN_JSON) { console.log('[Google] using env var token'); return true; }
  try { require('fs').readFileSync(require('path').join(__dirname, '..', 'google_token.json')); console.log('[Google] using file token'); return true; }
  catch { console.log('[Google] no token found — disabled'); return false; }
})();

// ── Intent classification ──────────────────────────────────────────────────────
const INTENT_SYSTEM = `You are an intent classifier for a Hebrew/English personal assistant.
Today's date and time (Asia/Jerusalem): {NOW}

Respond ONLY with valid JSON, no extra text.

Intents:
- "read_calendar": user wants to see calendar events. params: { "days": number (1=today,2=tomorrow,7=week) }
- "create_event": create new event. params: { "summary": string, "startDateTime": "YYYY-MM-DDTHH:MM:SS", "endDateTime": "YYYY-MM-DDTHH:MM:SS" }
- "update_event": rename/reschedule event. params: { "search": string, "updates": { "summary"?: string, "startDateTime"?: string, "endDateTime"?: string } }
- "delete_event": delete/remove event. params: { "search": string }
- "read_emails": see unread emails. params: { "maxResults": number }
- "chat": everything else. params: {}

Format: { "intent": "...", "params": { ... } }`;

async function classifyIntent(userMessage) {
  const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const res = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 400,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: INTENT_SYSTEM.replace('{NOW}', now) },
      { role: 'user', content: userMessage },
    ],
  });
  return JSON.parse(res.choices[0].message.content);
}

// ── Execute Google action ──────────────────────────────────────────────────────
async function executeGoogleAction(intent, params) {
  if (intent === 'read_calendar') {
    return { type: 'display', data: await getCalendarEvents(Number(params.days) || 1) };
  }
  if (intent === 'create_event') {
    const result = await createCalendarEvent(params.summary, params.startDateTime, params.endDateTime);
    return { type: 'direct', data: result };
  }
  if (intent === 'update_event') {
    const found = JSON.parse(await findEventsByQuery(params.search || ''));
    if (!found.found) return { type: 'direct', data: `לא נמצא אירוע עם השם "${params.search}"` };
    const result = await updateCalendarEvent(found.events[0].id, params.updates || {});
    return { type: 'direct', data: result };
  }
  if (intent === 'delete_event') {
    const found = JSON.parse(await findEventsByQuery(params.search || ''));
    if (!found.found) return { type: 'direct', data: `לא נמצא אירוע עם השם "${params.search}" ביומן.` };
    const result = await deleteCalendarEvent(found.events[0].id);
    return { type: 'direct', data: `${result} (${found.events[0].summary})` };
  }
  if (intent === 'read_emails') {
    return { type: 'display', data: await getUnreadEmails(Number(params.maxResults) || 5) };
  }
  return null;
}

// ── Generate model response (for display/chat only) ───────────────────────────
async function generateResponse(messages, googleData) {
  const extra = googleData
    ? [{ role: 'assistant', content: `[נתוני Google]\n${googleData}` },
       { role: 'user', content: 'תסכם לי את המידע הזה בצורה ברורה וקצרה' }]
    : [];

  const res = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: 'אתה עוזר אישי בשם LifePilot של שילה אלקובי. ענה בעברית קצר וישיר. אם קיבלת נתוני Google — הצג אותם בלבד, אל תמציא מידע נוסף.' },
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
        const actionResult = await executeGoogleAction(intent, params || {});

        // "direct" = return as-is (create/update/delete) — no model hallucination possible
        if (actionResult.type === 'direct') return actionResult.data;

        // "display" = pass through model to format nicely (read calendar/emails)
        if (actionResult.type === 'display') return await generateResponse(messages, actionResult.data);
      }
    } catch (err) {
      console.error('[Intent/Google error]', err.message);
    }
  }

  // Regular chat
  const res = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  });
  return res.choices[0].message.content || '(no response)';
}

module.exports = { askClaude };
