'use strict';

const fs   = require('fs');
const path = require('path');
const OpenAI = require('openai');
const {
  canCall, increment,
  canCallGemini, incrementGemini,
  canCallGroq, addGroqTokens,
  formatStats,
} = require('./rate-limiter');
const { getHistory, addMessage }       = require('./history');
const { loadMemory, formatMemoryBlock } = require('./agent-memory');
const { initRegistry, getAllToolDeclarations, executeAnyTool } = require('./skills-registry');

// ── Retry helper ─────────────────────────────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Module imports ────────────────────────────────────────────────────────────
const { addTask, markDone, deleteTask, getOpenTasks, getCompletedToday } = require('./tasks');
const { logDirect, getTodayHealth, getWeekSummary }                      = require('./health');
const { getTodayMedStatus, markTaken }                                   = require('./medications');
const {
  addReminderDirect, listPending, deleteReminder, formatTimeIL,
} = require('./reminders');
const { addNote, searchNotes, load: loadNotes }         = require('./notes');
const { getDailyWordSync, formatWord, formatStreak }    = require('./english');
const { startPomo, stopPomo, getTodayPomoStats }        = require('./pomodoro');
const { sendNews }                                      = require('./news');
const { load: loadSites, runChecks }                    = require('./sites');
const {
  getCalendarEvents, createCalendarEvent, getUnreadEmails,
  findEventsByQuery, updateCalendarEvent, deleteCalendarEvent,
} = require('./google');
const { saveDraft, listDrafts, deleteDraft } = require('./social');
const { getExpenses } = require('./expenses');

console.log('[Agent] Groq key present:', !!process.env.GROQ_API_KEY);
console.log('[Agent] Gemini key present:', !!process.env.GEMINI_API_KEY);
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});
const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

// ── Gemini tool format converter ──────────────────────────────────────────────
// Gemini 2.5 native API uses uppercase types; kept here for future native use.
function toGeminiTools(declarations) {
  return [{
    functionDeclarations: declarations.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters ? {
        type: 'OBJECT',
        properties: Object.fromEntries(
          Object.entries(t.parameters.properties || {})
            .map(([k, v]) => [k, {
              type: (v.type || 'string').toUpperCase(),
              description: v.description || ''
            }])
        ),
        required: t.parameters.required || []
      } : { type: 'OBJECT', properties: {} }
    }))
  }];
}

async function callLLM(messages, tools) {
  // FORCE_GEMINI=1 skips Groq entirely (used in tests / when Groq quota is exhausted)
  if (process.env.FORCE_GEMINI === '1') {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await gemini.chat.completions.create({
          model:       'gemini-2.5-flash',
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.7,
        });
        console.log(`[Agent] Provider: Gemini 2.5 Flash (forced) | finish_reason: ${res.choices[0]?.finish_reason} | tokens: ${res.usage?.total_tokens ?? '?'}`);
        return res;
      } catch (err) {
        if ((err.status === 429 || err.message?.includes('429')) && attempt < 2) {
          const waitSec = attempt === 0 ? 30 : 60;
          console.warn(`[Agent] Gemini 429 — waiting ${waitSec}s before retry ${attempt + 1}/2`);
          await _sleep(waitSec * 1000);
          continue;
        }
        throw err;
      }
    }
  }

  // Primary: Gemini 2.5 Flash — skip if at 95% of daily quota
  if (canCallGemini()) {
    try {
      const res = await gemini.chat.completions.create({
        model:       'gemini-2.5-flash',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.7,
      });
      incrementGemini();
      console.log(`[Agent] Provider: Gemini 2.5 Flash (primary) | finish_reason: ${res.choices[0]?.finish_reason} | tokens: ${res.usage?.total_tokens ?? '?'}`);
      return res;
    } catch (err) {
      if (err.status === 429 || err.message?.includes('429')) {
        console.warn('[Agent] Gemini 429 — falling back to Groq');
      } else {
        console.warn('[Agent] Gemini error — falling back to Groq:', err.message);
      }
    }
  } else {
    console.warn('[RateLimit] Gemini 95% — switching to Groq');
  }

  // Fallback: Groq
  if (!canCallGroq()) {
    throw new Error('daily_quota_exhausted');
  }
  const res = await groq.chat.completions.create({
    model:               'llama-3.3-70b-versatile',
    messages,
    tools,
    tool_choice:          'auto',
    parallel_tool_calls:  false,
    temperature:          0.7,
  });
  addGroqTokens(res.usage?.total_tokens ?? 0);
  console.log(`[Agent] Provider: Groq (fallback) | finish_reason: ${res.choices[0]?.finish_reason} | tokens: ${res.usage?.total_tokens ?? '?'}`);
  return res;
}

// Load Shilo's profile
let shiloProfile = '';
try { shiloProfile = fs.readFileSync(path.join(__dirname, '..', 'shilo_profile.md'), 'utf8'); } catch {}

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowIL() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}
function getDayHebrew() {
  return new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long' });
}

// ── Current context snapshot ──────────────────────────────────────────────────
function buildCurrentContext(chatId) {
  try {
    const health  = getTodayHealth();
    const tasks     = getOpenTasks()      ?? [];
    const medStatus = getTodayMedStatus() ?? {};
    const pomo      = getTodayPomoStats();
    const pending   = listPending(chatId) ?? [];
    return JSON.stringify({
      datetime:            nowIL(),
      day_hebrew:          getDayHebrew(),
      open_tasks:          tasks.length,
      tasks_high_priority: tasks.filter(t => t.priority === 'high').length,
      health_logged_today: !!health,
      pain_today:          health?.painLevel ?? null,
      mood_today:          health?.mood      ?? null,
      sleep_today:         health?.sleep     ?? null,
      meds_total:   medStatus.total   ?? 0,
      meds_taken:   medStatus.taken   ?? 0,
      meds_pending: medStatus.pending ?? 0,
      meds_missed:  medStatus.missed  ?? 0,
      reminders_pending:   pending.length,
      pomo_sessions_today: pomo?.sessions     ?? 0,
      pomo_minutes_today:  pomo?.totalMinutes ?? 0,
    });
  } catch (err) {
    return JSON.stringify({ datetime: nowIL(), error: err.message });
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(memory) {
  const memBlock = formatMemoryBlock(memory);
  const nowDisplay = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  return `LifePilot — עוזר של שילה (גבר, זכר בלבד) | ישראל
זמן: ${nowDisplay} | ${nowIL()} | ${getDayHebrew()}
CRPS רגל שמאל (DRG) — כאב כרוני
${memBlock ? 'זיכרון:\n' + memBlock + '\n' : ''}
• כלים: קרא רק כשמשתמש מבקש במפורש — משימה/תזכורת/בריאות/תרופות/חיפוש/מזג אוויר. אסור לקרוא ל-get_current_context על שאלות כלליות, סיפורים, שיחת חולין, או שאלות על אנשים/נושאים
• תזכורות: חשב בדיוק מהשעה הנ"ל
• שרשור: "כאב+תזכורת" → log_health → add_reminder
• 1-4 שורות, ✅, plain text, שאלה אחת מקסימום
• שיחת חולין: ענה בחום ללא כלים — שאל בחזרה, היה חבר
• כשהודעה מתחילה ב-[תמונה שנשלחה] — עיבדת תמונה בהצלחה דרך Vision AI, תאר מה ראית`;
}

// ── Tool definitions ──────────────────────────────────────────────────────────
// Descriptions kept to ≤15 words to minimize token usage (Groq: 100K/day budget).
const TOOL_DECLARATIONS = [
  // Tasks
  { name: 'add_task',       description: 'הוסף משימה חדשה לרשימה.', parameters: { type: 'object', properties: { text: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['text'] } },
  { name: 'get_tasks',      description: 'קבל רשימת המשימות הפתוחות.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'complete_task',  description: 'סמן משימה כבוצעת לפי מספר.', parameters: { type: 'object', properties: { task_index: { type: 'number', description: '1-based' } }, required: ['task_index'] } },
  { name: 'delete_task',    description: 'מחק משימה לצמיתות.', parameters: { type: 'object', properties: { task_index: { type: 'number', description: '1-based' } }, required: ['task_index'] } },
  // Health
  { name: 'log_health',         description: 'רשום כאב/שינה/מצב רוח ישירות ללא שאלון.', parameters: { type: 'object', properties: { pain: { type: 'number', description: 'pain 1-10 (חובה)' }, mood: { type: 'number', description: 'mood 1-10' }, sleep: { type: 'number', description: 'שעות שינה' }, symptoms: { type: 'string' }, notes: { type: 'string' } }, required: ['pain'] } },
  { name: 'get_health_today',   description: 'קבל דיווח הבריאות של היום.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'get_health_summary', description: 'קבל סיכום בריאות N ימים אחרונים.', parameters: { type: 'object', properties: { days: { type: 'number', description: 'ברירת מחדל: 7' } }, required: [] } },
  // Medications
  { name: 'get_med_status', description: 'הצג סטטוס תרופות היום.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'mark_med_taken', description: 'סמן תרופה כנלקחה.', parameters: { type: 'object', properties: { medication_name: { type: 'string' } }, required: ['medication_name'] } },
  // Reminders
  { name: 'add_reminder',    description: 'קבע תזכורת; חשב remind_at מהשעה הנוכחית בsystem prompt.', parameters: { type: 'object', properties: { task: { type: 'string' }, remind_at: { type: 'string', description: 'ISO 8601 datetime בשעון ישראל' } }, required: ['task', 'remind_at'] } },
  { name: 'get_reminders',   description: 'הצג כל התזכורות הממתינות.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'delete_reminder', description: 'מחק תזכורת לפי ID.', parameters: { type: 'object', properties: { reminder_id: { type: 'number' } }, required: ['reminder_id'] } },
  // Notes
  { name: 'save_note',      description: 'שמור הערה, קוד, רעיון או לינק.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'search_notes',   description: 'חפש בהערות השמורות לפי מילת מפתח.', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } },
  { name: 'get_recent_notes', description: 'קבל N הערות אחרונות.', parameters: { type: 'object', properties: { count: { type: 'number', description: 'ברירת מחדל: 5' } }, required: [] } },
  // English
  { name: 'get_daily_word',    description: 'קבל מילת האנגלית היומית.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'get_english_stats', description: 'קבל סטטיסטיקת לימוד אנגלית וstreak.', parameters: { type: 'object', properties: {}, required: [] } },
  // Pomodoro
  { name: 'start_pomodoro',    description: 'התחל סשן פומודורו (ברירת מחדל 25 דקות).', parameters: { type: 'object', properties: { minutes: { type: 'number' } }, required: [] } },
  { name: 'stop_pomodoro',     description: 'עצור את סשן הפומודורו הנוכחי.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'get_pomodoro_stats', description: 'קבל סטטיסטיקת פומודורו של היום.', parameters: { type: 'object', properties: {}, required: [] } },
  // News
  { name: 'get_tech_news', description: 'שלח חדשות טכנולוגיה מ-Hacker News.', parameters: { type: 'object', properties: { full: { type: 'boolean', description: 'true=10 כתבות, false=5 עם AI' } }, required: [] } },
  // Sites
  { name: 'get_site_status', description: 'הצג סטטוס up/down של האתרים.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'check_sites_now', description: 'בצע בדיקת up/down מיידית לאתרים.', parameters: { type: 'object', properties: {}, required: [] } },
  // Context
  { name: 'get_current_context', description: 'קבל סנפשוט נוכחי: משימות, בריאות, תרופות, תזכורות.', parameters: { type: 'object', properties: {}, required: [] } },
  // Calendar
  { name: 'get_calendar_events',  description: 'מביא אירועים מ-Google Calendar.', parameters: { type: 'object', properties: { days: { type: 'number', description: '1=היום, 7=שבוע (ברירת מחדל)' } }, required: [] } },
  { name: 'find_calendar_events', description: 'מחפש אירוע ביומן לפי שם — קרא לפני עדכון/מחיקה.', parameters: { type: 'object', properties: { query: { type: 'string' }, days: { type: 'number' } }, required: ['query'] } },
  { name: 'create_calendar_event', description: 'יוצר אירוע חדש ב-Google Calendar.', parameters: { type: 'object', properties: { summary: { type: 'string' }, startDateTime: { type: 'string', description: 'ISO 8601' }, endDateTime: { type: 'string', description: 'ISO 8601' } }, required: ['summary', 'startDateTime', 'endDateTime'] } },
  { name: 'update_calendar_event', description: 'מעדכן אירוע קיים; דרוש eventId מ-find_calendar_events.', parameters: { type: 'object', properties: { eventId: { type: 'string' }, summary: { type: 'string' }, startDateTime: { type: 'string' }, endDateTime: { type: 'string' } }, required: ['eventId'] } },
  { name: 'delete_calendar_event', description: 'מוחק אירוע מ-Google Calendar לפי eventId.', parameters: { type: 'object', properties: { eventId: { type: 'string' }, summary: { type: 'string' } }, required: ['eventId'] } },
  { name: 'get_unread_emails',     description: 'מביא מיילים שלא נקראו מ-Gmail.', parameters: { type: 'object', properties: { maxResults: { type: 'number', description: 'ברירת מחדל: 5' } }, required: [] } },
  // Rate Limit
  { name: 'get_rate_stats', description: 'הצג מצב מכסת API: Gemini, Groq, כללי.', parameters: { type: 'object', properties: {}, required: [] } },
  // Social
  { name: 'save_social_draft',   description: 'שמור טיוטת פוסט לסושיאל מדיה.', parameters: { type: 'object', properties: { platform: { type: 'string', description: 'Instagram/Facebook/TikTok' }, content: { type: 'string' }, hashtags: { type: 'string' }, imagePrompt: { type: 'string' } }, required: ['platform', 'content'] } },
  { name: 'list_social_drafts',  description: 'הצג כל טיוטות הפוסטים.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'delete_social_draft', description: 'מחק טיוטת פוסט לפי ID.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  // Expenses
  { name: 'get_expenses', description: 'הצג קבלות/הוצאות שנסרקו מתמונות.', parameters: { type: 'object', properties: {}, required: [] } },
];

// ── Split tools: CORE (always sent) vs EXTENDED (sent only when relevant) ────
const CORE_TOOL_NAMES = new Set([
  'get_tasks', 'add_task', 'complete_task', 'delete_task',
  'log_health', 'get_health_today',
  'add_reminder', 'get_reminders',
  'get_current_context',
  'get_rate_stats',
  'get_expenses',
]);

const EXTENDED_KEYWORDS = [
  'news', 'חדשות', 'english', 'אנגלית', 'מילה', 'streak',
  'pomodoro', 'פומודורו', 'טיימר',
  'sites', 'אתרים', 'אתר',
  'calendar', 'יומן', 'אירוע', 'פגישה',
  'email', 'מייל', 'gmail',
  'social', 'פוסט', 'instagram', 'facebook', 'tiktok',
  'notes', 'הערות', 'הערה', 'חפש',
  'health summary', 'סיכום בריאות',
  'medications', 'תרופות', 'med',
  'pomodoro stats',
  // Web search triggers
  'חיפוש', 'search', 'מחיר', 'כמה עולה', 'מה זה', 'תחפש', 'תבדוק', 'מה המחיר',
  // OCR triggers
  'סרוק', 'ocr', 'חלץ טקסט', 'קבלה', 'מרשם', 'כרטיס ביקור',
];

function selectTools(userText) {
  const lower = userText.toLowerCase();
  const needsExtended = EXTENDED_KEYWORDS.some(kw => lower.includes(kw));
  const decls = needsExtended
    ? TOOL_DECLARATIONS
    : TOOL_DECLARATIONS.filter(t => CORE_TOOL_NAMES.has(t.name));
  const builtInTools = decls.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  // Always append skill tools (web_search, etc.) from the registry
  const allDecls = getAllToolDeclarations();
  const skillTools = allDecls.slice(TOOL_DECLARATIONS.length);
  return [...builtInTools, ...skillTools];
}

// ── Convert TOOL_DECLARATIONS → OpenAI/Groq format (full set, used by registry) ─
const TOOLS = TOOL_DECLARATIONS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// ── Test-mode tool call tracker ───────────────────────────────────────────────
const _toolCalls = [];
function _resetToolCalls() { _toolCalls.length = 0; }
function _getToolCalls() { return [..._toolCalls]; }

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, ctx) {
  const { bot, chatId } = ctx;
  args = (args && typeof args === 'object') ? args : {};

  // Coerce known numeric fields — Groq/Gemini sometimes returns numbers as strings
  const numericFields = ['pain', 'mood', 'sleep', 'task_id', 'task_index', 'reminder_id', 'note_id', 'minutes', 'position', 'days', 'count', 'maxResults'];
  for (const field of numericFields) {
    if (field in args && typeof args[field] === 'string') {
      args[field] = Number(args[field]);
    }
  }

  if (process.env.TEST_MODE === '1') _toolCalls.push({ name, args });
  console.log(`[Agent] Tool: ${name}`, args);

  try {
    switch (name) {

      // ── Tasks ──────────────────────────────────────────────────────────────
      case 'add_task': {
        const text = args.priority === 'high' ? `!${args.text}` : args.text;
        const task = addTask(text);
        if (!task) return 'שגיאה: לא הצלחתי להוסיף משימה';
        return `נוסף: #${task.id} "${task.text}" [${task.priority}]`;
      }
      case 'get_tasks': {
        const tasks = getOpenTasks();
        if (!tasks.length) return 'אין משימות פתוחות';
        return tasks.map((t, i) =>
          `${i + 1}. [${t.priority}] ${t.text}`
        ).join('\n');
      }
      case 'complete_task': {
        const task = markDone(args.task_index);
        if (!task) return `שגיאה: משימה ${args.task_index} לא נמצאה`;
        return `בוצע: "${task.text}"`;
      }
      case 'delete_task': {
        const task = deleteTask(args.task_index);
        if (!task) return `שגיאה: משימה ${args.task_index} לא נמצאה`;
        return `נמחק: "${task.text}"`;
      }

      // ── Health ─────────────────────────────────────────────────────────────
      case 'log_health': {
        const entry = logDirect({
          pain:     args.pain,
          mood:     args.mood     || null,
          sleep:    args.sleep    || null,
          symptoms: args.symptoms || '',
          notes:    args.notes    || '',
        });
        return `נרשם: כאב ${entry.painLevel}/10` +
          (entry.mood  ? `, מצב רוח ${entry.mood}/10`    : '') +
          (entry.sleep ? `, שינה ${entry.sleep} שעות`     : '') +
          (entry.symptoms ? `, תסמינים: ${entry.symptoms}` : '');
      }
      case 'get_health_today': {
        const h = getTodayHealth();
        if (!h) return 'לא נרשם דיווח בריאות היום';
        return `כאב: ${h.painLevel}/10, מצב רוח: ${h.mood}/10, שינה: ${h.sleep}ש'` +
          (h.symptoms ? `, תסמינים: ${h.symptoms}` : '') +
          (h.notes    ? `, הערות: ${h.notes}`        : '');
      }
      case 'get_health_summary': {
        const days = Number(args.days) || 7;
        return getWeekSummary(days);
      }

      // ── Medications ────────────────────────────────────────────────────────
      case 'get_med_status': {
        const s = getTodayMedStatus();
        if (!s || s.total === 0) return 'אין תרופות מוגדרות';
        return `תרופות היום: ${s.taken}/${s.total} נלקחו | ${s.pending} ממתינות | ${s.missed} הוחמצו | ${s.skipped} דולגו`;
      }
      case 'mark_med_taken': {
        const result = markTaken(args.medication_name);
        if (!result) return `שגיאה: תרופה "${args.medication_name}" לא נמצאה`;
        return `✅ ${result.med.name} נלקח ב-${result.time}`;
      }

      // ── Reminders ──────────────────────────────────────────────────────────
      case 'add_reminder': {
        const reminder = addReminderDirect(chatId, args.task, args.remind_at);
        if (!reminder) return 'שגיאה: זמן לא תקין או בעבר';
        return `תזכורת נקבעה: "${reminder.task}" ב-${formatTimeIL(reminder.remindAt)}`;
      }
      case 'get_reminders': {
        const pending = listPending(chatId);
        if (!pending.length) return 'אין תזכורות ממתינות';
        return pending.map((r, i) =>
          `${i + 1}. "${r.task}" — ${formatTimeIL(r.remindAt)} (ID: ${r.id})`
        ).join('\n');
      }
      case 'delete_reminder': {
        const ok = deleteReminder(chatId, args.reminder_id);
        return ok ? `תזכורת ${args.reminder_id} נמחקה` : `תזכורת ${args.reminder_id} לא נמצאה`;
      }

      // ── Notes ──────────────────────────────────────────────────────────────
      case 'save_note': {
        const note = await addNote(args.content);
        return `נשמר #${note.id}: "${note.title}"` +
          (note.tags.length ? ` [${note.tags.join(', ')}]` : '');
      }
      case 'search_notes': {
        const results = searchNotes(args.keyword);
        if (!results.length) return `לא נמצאו הערות עבור "${args.keyword}"`;
        return results.map(n => `#${n.id}: ${n.title} [${n.tags.join(', ')}]`).join('\n');
      }
      case 'get_recent_notes': {
        const count = Number(args.count) || 5;
        const notes = loadNotes().slice(-count).reverse();
        if (!notes.length) return 'אין הערות שמורות';
        return notes.map(n => `#${n.id}: ${n.title} [${n.tags.join(', ')}]`).join('\n');
      }

      // ── English ────────────────────────────────────────────────────────────
      case 'get_daily_word': {
        const word = getDailyWordSync();
        return `${word.word} = ${word.translation} (${word.partOfSpeech}, ${word.difficulty})\nדוגמה: ${word.example}`;
      }
      case 'get_english_stats': {
        return formatStreak();
      }

      // ── Pomodoro ───────────────────────────────────────────────────────────
      case 'start_pomodoro': {
        const mins = Number(args.minutes) || 25;
        startPomo(bot, chatId, mins);
        return `פומודורו התחיל: ${mins} דקות`;
      }
      case 'stop_pomodoro': {
        stopPomo(bot, chatId);
        return 'פומודורו הופסק';
      }
      case 'get_pomodoro_stats': {
        const stats = getTodayPomoStats();
        if (!stats || !stats.sessions) return 'אין סשנים היום עדיין';
        return `היום: ${stats.sessions} סשנים, ${stats.totalMinutes} דקות סה"כ`;
      }

      // ── News ───────────────────────────────────────────────────────────────
      case 'get_tech_news': {
        sendNews(bot, chatId, !!args.full);
        return 'חדשות נשלחות...';
      }

      // ── Sites ──────────────────────────────────────────────────────────────
      case 'get_site_status': {
        const sites = loadSites();
        if (!sites.length) return 'אין אתרים במעקב';
        return sites.map(s =>
          `${s.name}: ${s.lastStatus === 200 ? '🟢 UP' : s.lastStatus === null ? '⬜ לא נבדק' : '🔴 DOWN'}`
        ).join('\n');
      }
      case 'check_sites_now': {
        runChecks(bot, chatId);
        return 'בדיקת אתרים החלה...';
      }

      // ── Context ────────────────────────────────────────────────────────────
      case 'get_current_context': {
        return buildCurrentContext(chatId);
      }

      // ── Calendar ───────────────────────────────────────────────────────────
      case 'get_calendar_events':    return await getCalendarEvents(Number(args.days) || 7);
      case 'find_calendar_events':   return await findEventsByQuery(args.query, Number(args.days) || 30);
      case 'create_calendar_event':  return await createCalendarEvent(args.summary, args.startDateTime, args.endDateTime);
      case 'update_calendar_event':  return await updateCalendarEvent(args.eventId, { summary: args.summary, startDateTime: args.startDateTime, endDateTime: args.endDateTime });
      case 'delete_calendar_event':  return await deleteCalendarEvent(args.eventId);
      case 'get_unread_emails':      return await getUnreadEmails(Number(args.maxResults) || 5);

      // ── Social ─────────────────────────────────────────────────────────────
      case 'save_social_draft':   return saveDraft(args);
      case 'list_social_drafts':  return listDrafts();
      case 'delete_social_draft': return deleteDraft(args.id);

      // ── Expenses ───────────────────────────────────────────────────────────
      case 'get_expenses': {
        const exps = getExpenses();
        if (!exps.length) return 'אין קבלות שמורות עדיין';
        return exps.slice(0, 20).map(e =>
          `#${e.id}: ${e.store || '?'} | ${e.amount || '?'} | ${e.date || '?'}`
        ).join('\n');
      }

      // ── Rate Stats ─────────────────────────────────────────────────────────
      case 'get_rate_stats': return formatStats();

      default:
        return `כלי לא מוכר: ${name}`;
    }
  } catch (err) {
    console.error(`[Agent] Tool error [${name}]:`, err.message);
    return `שגיאה בכלי ${name}: ${err.message}`;
  }
}

// ── Sanitize malformed tool calls from Groq ───────────────────────────────────
// Groq bug: sometimes returns name = 'add_reminder{"key":"val"}' with args in name.
// Mutates tc.function in place so history pushed to chatMessages stays clean.
function parseToolCall(tc) {
  let name = tc.function.name;
  let args = tc.function.arguments;

  const braceIdx = name.indexOf('{');
  if (braceIdx !== -1) {
    console.warn('[Agent] Malformed tool name, splitting:', name.slice(0, 60));
    args = name.slice(braceIdx);
    name = name.slice(0, braceIdx).trim();
    tc.function.name      = name;
    tc.function.arguments = args;
  }

  let parsed = {};
  try {
    parsed = typeof args === 'string' ? JSON.parse(args) : (args || {});
  } catch (e) {
    console.error('[Agent] Failed to parse tool args:', args);
  }
  // Groq sometimes sends "null" — JSON.parse("null") = null, not an object
  if (!parsed || typeof parsed !== 'object') parsed = {};
  return { name, args: parsed };
}

// ── Strip orphaned tool_calls from history before sending to Groq ─────────────
// Groq rule: every assistant message with tool_calls MUST be followed by a tool
// result. Any that aren't cause 400. This happens when tool execution throws.
function sanitizeHistory(messages) {
  const clean = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const next = messages[i + 1];
      if (next?.role !== 'tool') {
        console.warn('[Agent] Dropping orphaned tool_call from history:', msg.tool_calls[0]?.function?.name);
        continue;
      }
    }
    clean.push(msg);
  }
  return clean;
}

// ── Register built-ins + load skills ──────────────────────────────────────────
initRegistry(TOOL_DECLARATIONS, executeTool);

// ── Convert history to OpenAI format ─────────────────────────────────────────
function toOpenAIHistory(messages) {
  // Exclude the last (current) message; keep only the last 8 for token efficiency
  return messages.slice(0, -1).slice(-8).map(m => ({
    role: m.role === 'model' ? 'assistant' : (m.role === 'assistant' ? 'assistant' : 'user'),
    content: m.content || '',
  }));
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function handleMessage(bot, chatId, text) {
  console.log('[Agent] START:', text);

  if (!canCall()) {
    return '⚠️ הגעתי למגבלת 500 קריאות API היום. נתאפס בחצות.\n\n/usage — לראות סטטוס';
  }
  increment();

  addMessage(chatId, 'user', text);
  const messages = getHistory(chatId);
  const memory   = loadMemory(chatId);
  const tools    = selectTools(text);

  // Build message array for Groq
  const chatMessages = [
    { role: 'system', content: buildSystemPrompt(memory) },
    ...toOpenAIHistory(messages),
    { role: 'user', content: text },
  ];

  let response;
  try {
    response = await callLLM(sanitizeHistory(chatMessages), tools);
  } catch (err) {
    console.error('[Agent] FULL ERROR:', err.stack || err);
    if (err.message === 'daily_quota_exhausted') {
      const reply = '🔴 המכסה היומית של כל הספקים אזלה. מתאפס בחצות שעון ישראל.';
      addMessage(chatId, 'model', reply);
      return reply;
    }
    if (err.status === 429 || err.message?.includes('429')) {
      const reply = '⏳ הגבלת קריאות API — נסה שוב בעוד כמה דקות.';
      addMessage(chatId, 'model', reply);
      return reply;
    }
    throw err;
  }
  console.log('[Agent] Full message:', JSON.stringify(response.choices[0].message));

  // Add assistant message to history buffer
  chatMessages.push(response.choices[0].message);

  // ── Handle empty stop (no text, no tool_calls) — nudge once ─────────────
  {
    const msg = response.choices[0]?.message;
    const isEmpty = !msg?.tool_calls?.length && (!msg?.content || !msg.content.trim());
    if (isEmpty && response.choices[0]?.finish_reason === 'stop') {
      console.warn('[Agent] Empty stop response — nudging model to use a tool');
      chatMessages.push({ role: 'user', content: 'נא להשתמש בכלי המתאים כדי לבצע את הפעולה.' });
      if (canCall()) {
        increment();
        try {
          response = await callLLM(sanitizeHistory(chatMessages), tools);
          chatMessages.push(response.choices[0].message);
        } catch (err) {
          console.error('[Agent] Nudge retry error:', err.message);
        }
      }
    }
  }

  // ── ReAct loop — max 4 tool-call rounds ───────────────────────────────────
  for (let depth = 0; depth < 4; depth++) {
    const toolCalls = response.choices[0]?.message?.tool_calls;
    if (!toolCalls?.length) break; // model returned text — done

    // Execute all tool calls
    const toolResults = await Promise.all(
      toolCalls.map(async tc => {
        const { name: toolName, args } = parseToolCall(tc);
        console.log('[Agent] Tool:', toolName, JSON.stringify(args));
        let result;
        try {
          result = await executeAnyTool(toolName, args, { bot, chatId });
          console.log('[Agent] Tool result:', String(result).substring(0, 200));
        } catch (err) {
          console.error(`[Agent] Tool threw [${toolName}]:`, err.message);
          result = `error: ${err.message}`;
        }
        return { role: 'tool', tool_call_id: tc.id, content: String(result) };
      })
    );

    chatMessages.push(...toolResults);

    if (!canCall()) {
      const reply = '⚠️ הגבלת API — לא הצלחתי לסיים את הפעולה.';
      addMessage(chatId, 'model', reply);
      return reply;
    }
    increment();

    try {
      response = await callLLM(sanitizeHistory(chatMessages), tools);
      chatMessages.push(response.choices[0].message);
    } catch (err) {
      console.error('[Agent] FULL ERROR:', err.stack || err);
      if (err.status === 429 || err.message?.includes('429')) {
        const reply = '⏳ הגבלת קריאות API — נסה שוב בעוד כמה דקות.';
        addMessage(chatId, 'model', reply);
        return reply;
      }
      throw err;
    }
  }

  const rawContent = response.choices[0]?.message?.content;
  const reply = (rawContent && rawContent.trim()) ? rawContent.trim() : 'לא הצלחתי להבין. אפשר לנסח אחרת?';
  console.log('[Agent] REPLY:', reply);
  addMessage(chatId, 'model', reply);
  return reply;
}

module.exports = { handleMessage, _resetToolCalls, _getToolCalls };
