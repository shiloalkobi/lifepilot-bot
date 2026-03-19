'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  getCalendarEvents,
  createCalendarEvent,
  getUnreadEmails,
  findEventsByQuery,
  updateCalendarEvent,
  deleteCalendarEvent,
} = require('./google');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `אתה LifePilot — העוזר האישי של שילה אלקובי.
אזור זמן: Asia/Jerusalem. תאריך היום: ${new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.

יש לך גישה מלאה ליומן Google Calendar ולGmail של שילה דרך הכלים שלמטה.
ענה בעברית קצר וישיר. כשמבצעים פעולה ביומן — דווח בדיוק מה בוצע.`;

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_calendar_events',
      description: 'מביא אירועים מהיומן. השתמש כשהמשתמש רוצה לראות מה יש ביומן.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '1=היום, 2=מחר, 7=השבוע' },
        },
        required: ['days'],
      },
    },
    {
      name: 'find_calendar_events',
      description: 'מחפש אירוע ביומן לפי שם. השתמש לפני עדכון או מחיקה כדי לקבל את ה-ID.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'שם האירוע לחיפוש (חלקי)' },
          days:  { type: 'number', description: 'כמה ימים קדימה לחפש (ברירת מחדל 30)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'create_calendar_event',
      description: 'יוצר אירוע חדש ביומן.',
      parameters: {
        type: 'object',
        properties: {
          summary:       { type: 'string', description: 'שם האירוע' },
          startDateTime: { type: 'string', description: 'ISO 8601 לדוגמה: 2026-03-20T15:00:00' },
          endDateTime:   { type: 'string', description: 'ISO 8601 שעת סיום' },
        },
        required: ['summary', 'startDateTime', 'endDateTime'],
      },
    },
    {
      name: 'update_calendar_event',
      description: 'מעדכן אירוע קיים (שם/שעה/תאריך). יש לקרוא קודם ל-find_calendar_events.',
      parameters: {
        type: 'object',
        properties: {
          eventId:       { type: 'string', description: 'ID של האירוע (מ-find_calendar_events)' },
          summary:       { type: 'string', description: 'שם חדש (אופציונלי)' },
          startDateTime: { type: 'string', description: 'שעת התחלה חדשה ISO 8601 (אופציונלי)' },
          endDateTime:   { type: 'string', description: 'שעת סיום חדשה ISO 8601 (אופציונלי)' },
        },
        required: ['eventId'],
      },
    },
    {
      name: 'delete_calendar_event',
      description: 'מוחק אירוע מהיומן. יש לקרוא קודם ל-find_calendar_events.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'ID של האירוע למחיקה' },
          summary: { type: 'string', description: 'שם האירוע (לאישור בלבד)' },
        },
        required: ['eventId'],
      },
    },
    {
      name: 'get_unread_emails',
      description: 'מביא מיילים שלא נקראו.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'כמה מיילים (ברירת מחדל 5)' },
        },
        required: [],
      },
    },
  ],
}];

// ── Execute a function call from the model ────────────────────────────────────
async function executeTool(name, args) {
  console.log(`[Tool] ${name}`, args);
  try {
    if (name === 'get_calendar_events') {
      return await getCalendarEvents(Number(args.days) || 1);
    }
    if (name === 'find_calendar_events') {
      return await findEventsByQuery(args.query, Number(args.days) || 30);
    }
    if (name === 'create_calendar_event') {
      return await createCalendarEvent(args.summary, args.startDateTime, args.endDateTime);
    }
    if (name === 'update_calendar_event') {
      return await updateCalendarEvent(args.eventId, {
        summary: args.summary,
        startDateTime: args.startDateTime,
        endDateTime: args.endDateTime,
      });
    }
    if (name === 'delete_calendar_event') {
      return await deleteCalendarEvent(args.eventId);
    }
    if (name === 'get_unread_emails') {
      return await getUnreadEmails(Number(args.maxResults) || 5);
    }
    return 'כלי לא ידוע';
  } catch (err) {
    console.error(`[Tool error] ${name}:`, err.message);
    return `שגיאה: ${err.message}`;
  }
}

// ── Convert history to Gemini format ─────────────────────────────────────────
function toGeminiHistory(messages) {
  // All messages except the last user message go into history
  return messages.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

const googleReady = (() => {
  if (process.env.GOOGLE_TOKEN_JSON) { console.log('[Google] using env var token'); return true; }
  try { require('fs').readFileSync(require('path').join(__dirname, '..', 'google_token.json')); console.log('[Google] using file token'); return true; }
  catch { console.log('[Google] no token found — disabled'); return false; }
})();

// ── Main entry ────────────────────────────────────────────────────────────────
async function askClaude(messages) {
  const lastMessage = messages[messages.length - 1]?.content || '';
  const history = toGeminiHistory(messages);

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    tools: googleReady ? TOOLS : [],
  });

  const chat = model.startChat({ history });

  // Tool calling loop — model can call multiple tools before final answer
  let result = await chat.sendMessage(lastMessage);

  for (let i = 0; i < 5; i++) { // max 5 tool call rounds
    const candidate = result.response.candidates?.[0];
    if (!candidate) break;

    const functionCalls = candidate.content.parts.filter((p) => p.functionCall);
    if (functionCalls.length === 0) break;

    // Execute all requested tool calls
    const toolResponses = await Promise.all(
      functionCalls.map(async (p) => {
        const output = await executeTool(p.functionCall.name, p.functionCall.args);
        return {
          functionResponse: {
            name: p.functionCall.name,
            response: { result: String(output) },
          },
        };
      })
    );

    // Send results back to model
    result = await chat.sendMessage(toolResponses);
  }

  return result.response.text() || '(no response)';
}

module.exports = { askClaude };
