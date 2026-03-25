'use strict';

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
  getCalendarEvents,
  createCalendarEvent,
  getUnreadEmails,
  findEventsByQuery,
  updateCalendarEvent,
  deleteCalendarEvent,
} = require('./google');

const { saveDraft, listDrafts, deleteDraft } = require('./social');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Load Shilo's profile from file
let shiloProfile = '';
try {
  shiloProfile = fs.readFileSync(path.join(__dirname, '..', 'shilo_profile.md'), 'utf8');
} catch (err) {
  console.error('[Warning] Could not load shilo_profile.md:', err.message);
}

const SYSTEM_PROMPT = `אתה LifePilot — העוזר האישי של שילה אלקובי.
אזור זמן: Asia/Jerusalem. תאריך היום: ${new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.

## הפרופיל המלא של שילה
${shiloProfile}

יש לך גישה מלאה ליומן Google Calendar ולGmail של שילה דרך הכלים שלמטה.
ענה בעברית קצר וישיר. כשמבצעים פעולה ביומן — דווח בדיוק מה בוצע.
כשנשאלים על שילה — השתמש במידע מהפרופיל למעלה כדי לענות בצורה מלאה ומדויקת.

## יכולות שיווק בסושיאל מדיה
אתה יכול ליצור תוכן לסושיאל מדיה לפי הפלטפורמה:

**Instagram:** קפשן עד 2200 תווים, אמוג'י, שורת hook ראשונה חזקה, 5-15 האשטגים רלוונטיים.
**Facebook:** יותר מידע, טון שיחתי, שאלה לסיום לעידוד תגובות, 3-5 האשטגים בלבד.
**TikTok:** קצר ומכוון, טון צעיר ואנרגטי, hook חזק ב-3 שניות, 3-7 האשטגים טרנדיים.

כשמבקשים פוסט — כתוב קודם את הקפשן המלא, אח"כ האשטגים בנפרד.
כשמבקשים prompt לתמונה — כתוב בפורמט מפורט באנגלית (סגנון, תאורה, קומפוזיציה, צבעים).
כשמבקשים תכנית תוכן שבועית — הצג טבלה עם יום / פלטפורמה / נושא / פורמט.
אחרי יצירת תוכן — שאל אם לשמור כטיוטה.`;

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
    {
      name: 'save_social_draft',
      description: 'שומר טיוטת פוסט לסושיאל מדיה. השתמש כשהמשתמש מבקש לשמור פוסט שנוצר.',
      parameters: {
        type: 'object',
        properties: {
          platform:    { type: 'string', description: 'הפלטפורמה: Instagram / Facebook / TikTok' },
          content:     { type: 'string', description: 'טקסט הפוסט המלא' },
          hashtags:    { type: 'string', description: 'האשטגים (אופציונלי)' },
          imagePrompt: { type: 'string', description: 'prompt לתמונה אם נוצר (אופציונלי)' },
        },
        required: ['platform', 'content'],
      },
    },
    {
      name: 'list_social_drafts',
      description: 'מציג את כל טיוטות הפוסטים השמורות.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'delete_social_draft',
      description: 'מוחק טיוטת פוסט לפי ID.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ה-ID של הטיוטה למחיקה' },
        },
        required: ['id'],
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
    if (name === 'save_social_draft') {
      return saveDraft(args);
    }
    if (name === 'list_social_drafts') {
      return listDrafts();
    }
    if (name === 'delete_social_draft') {
      return deleteDraft(args.id);
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

const { canCall, increment } = require('./rate-limiter');

// ── Main entry ────────────────────────────────────────────────────────────────
async function askClaude(messages) {
  if (!canCall()) {
    return '⚠️ הגעתי למגבלה היומית של בקשות AI. נתאפס בחצות.\n\n/usage — לראות כמה קריאות נוצלו';
  }
  increment();

  const lastMessage = messages[messages.length - 1]?.content || '';
  const history = toGeminiHistory(messages);

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-001',
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
