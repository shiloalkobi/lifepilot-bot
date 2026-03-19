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
  if (name === 'get_calendar_events')  return await getCalendarEvents(args.days || 1);
  if (name === 'create_calendar_event') return await createCalendarEvent(args.summary, args.startDateTime, args.endDateTime);
  if (name === 'get_unread_emails')    return await getUnreadEmails(args.maxResults || 5);
  return 'כלי לא ידוע';
}

async function askClaude(messages) {
  const googleReady = (() => {
    if (process.env.GOOGLE_TOKEN_JSON) return true;
    try { require('fs').readFileSync(require('path').join(__dirname, '..', 'google_token.json')); return true; }
    catch { return false; }
  })();

  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    tools: googleReady ? TOOLS : undefined,
    tool_choice: googleReady ? 'auto' : undefined,
  });

  const choice = response.choices[0];

  // No tool call — plain text reply
  if (choice.finish_reason !== 'tool_calls') {
    return choice.message.content || '(no response)';
  }

  // Execute tool calls
  const toolCall  = choice.message.tool_calls[0];
  const toolName  = toolCall.function.name;
  const toolArgs  = JSON.parse(toolCall.function.arguments);
  const toolResult = await callTool(toolName, toolArgs);

  // Send result back to model for a natural reply
  const followUp = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
      choice.message,
      { role: 'tool', tool_call_id: toolCall.id, content: toolResult },
    ],
  });

  return followUp.choices[0].message.content || toolResult;
}

module.exports = { askClaude };
