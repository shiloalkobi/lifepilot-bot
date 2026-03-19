'use strict';

const Groq = require('groq-sdk');
const { loadSystemPrompt } = require('./system_prompt');
const { getCalendarEvents, createCalendarEvent, getUnreadEmails } = require('./google');

const client       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const systemPrompt = loadSystemPrompt();

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_calendar_events',
      description: 'מביא אירועים מהיומן של המשתמש. השתמש כשהמשתמש שואל על פגישות, מה יש היום/מחר/השבוע.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'כמה ימים קדימה להביא (1=היום, 2=מחר, 7=השבוע)' },
        },
        required: ['days'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'יוצר אירוע חדש ביומן.',
      parameters: {
        type: 'object',
        properties: {
          summary:       { type: 'string', description: 'שם האירוע' },
          startDateTime: { type: 'string', description: 'תאריך ושעת התחלה בפורמט ISO 8601, לדוגמה: 2026-03-20T15:00:00' },
          endDateTime:   { type: 'string', description: 'תאריך ושעת סיום בפורמט ISO 8601' },
        },
        required: ['summary', 'startDateTime', 'endDateTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_unread_emails',
      description: 'מביא מיילים שלא נקראו מהתיבת הדואר הנכנס.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'כמה מיילים להביא (ברירת מחדל: 5)' },
        },
        required: [],
      },
    },
  },
];

async function callTool(name, args) {
  if (name === 'get_calendar_events')   return await getCalendarEvents(Number(args.days) || 1);
  if (name === 'create_calendar_event') return await createCalendarEvent(args.summary, args.startDateTime, args.endDateTime);
  if (name === 'get_unread_emails')     return await getUnreadEmails(Number(args.maxResults) || 5);
  return 'כלי לא ידוע';
}

const CALENDAR_KEYWORDS = ['יומן', 'פגישה', 'פגישות', 'היום', 'מחר', 'השבוע', 'אירוע', 'לוז', 'תזכורת'];
const EMAIL_KEYWORDS    = ['מייל', 'מיילים', 'אימייל', 'דואר', 'inbox', 'email'];

function detectIntent(text) {
  const lower = text.toLowerCase();
  if (EMAIL_KEYWORDS.some((k) => lower.includes(k)))    return 'email';
  if (CALENDAR_KEYWORDS.some((k) => lower.includes(k))) return 'calendar';
  return null;
}

function getDaysFromText(text) {
  if (text.includes('השבוע')) return 7;
  if (text.includes('מחר'))   return 2;
  return 1;
}

const googleReady = (() => {
  if (process.env.GOOGLE_TOKEN_JSON) { console.log('[Google] using env var token'); return true; }
  try { require('fs').readFileSync(require('path').join(__dirname, '..', 'google_token.json')); console.log('[Google] using file token'); return true; }
  catch { console.log('[Google] no token found — disabled'); return false; }
})();

async function askClaude(messages) {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  // Google shortcuts — bypass model tool calling
  if (googleReady) {
    const intent = detectIntent(lastUserMessage);
    if (intent === 'calendar') {
      const days = getDaysFromText(lastUserMessage);
      const data = await getCalendarEvents(days);
      const followUp = await client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
          { role: 'assistant', content: `נתוני יומן Google:\n${data}` },
          { role: 'user', content: 'תסכם לי את האירועים בצורה ברורה' },
        ],
      });
      return followUp.choices[0].message.content || data;
    }
    if (intent === 'email') {
      const data = await getUnreadEmails(5);
      const followUp = await client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
          { role: 'assistant', content: `מיילים לא נקראים:\n${data}` },
          { role: 'user', content: 'תסכם לי את המיילים בצורה ברורה' },
        ],
      });
      return followUp.choices[0].message.content || data;
    }
  }

  // Regular chat
  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  });

  return response.choices[0].message.content || '(no response)';
}

module.exports = { askClaude };
