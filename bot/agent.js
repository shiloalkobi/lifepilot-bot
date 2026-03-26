'use strict';

const fs   = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { canCall, increment }           = require('./rate-limiter');
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

async function callLLM(messages, tools) {
  // FORCE_GEMINI=1 skips Groq entirely (used in tests / when Groq quota is exhausted)
  if (process.env.FORCE_GEMINI === '1') {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await gemini.chat.completions.create({
          model:       'gemini-3-flash-preview',
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.7,
        });
        console.log(`[Agent] Provider: Gemini (forced) | finish_reason: ${res.choices[0]?.finish_reason} | tokens: ${res.usage?.total_tokens ?? '?'}`);
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

  try {
    const res = await groq.chat.completions.create({
      model:               'llama-3.3-70b-versatile',
      messages,
      tools,
      tool_choice:          'auto',
      parallel_tool_calls:  false,
      temperature:          0.7,
    });
    console.log(`[Agent] Provider: Groq | finish_reason: ${res.choices[0]?.finish_reason} | tokens: ${res.usage?.total_tokens ?? '?'}`);
    return res;
  } catch (err) {
    if (err.status === 429 || err.message?.includes('429')) {
      console.warn('[Agent] Groq 429 — falling back to Gemini');
      const res = await gemini.chat.completions.create({
        model:       'gemini-3-flash-preview',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.7,
      });
      console.log(`[Agent] Provider: Gemini | finish_reason: ${res.choices[0]?.finish_reason} | tokens: ${res.usage?.total_tokens ?? '?'}`);
      return res;
    }
    throw err;
  }
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
  return `אתה LifePilot — העוזר האישי של שילה אלקובי.
השעה הנוכחית בישראל: ${nowDisplay}
ISO: ${nowIL()} | יום: ${getDayHebrew()}

## פרופיל
שילה אלקובי | ראשון לציון | Node.js/WordPress/AI | גבר
CRPS ברגל שמאל (DRG שתל) — כאב כרוני, ניהול יומי
${memBlock ? '## זיכרון\n' + memBlock + '\n' : ''}
## כללים — CRITICAL
0. שילה הוא גבר — תמיד פנה אליו בלשון זכר. לעולם לא בלשון נקבה.
1. ALWAYS use tools before answering. NEVER answer from memory about tasks, health, medications, or reminders — always call the appropriate tool first.
2. Time calculations (add_reminder): use the Israel time shown above and calculate precisely. "בעוד 10 דקות" = add 10 minutes to current time.
3. Chain tools when needed: "כאב + תזכורת" → log_health then add_reminder.
4. Short replies, 1-4 lines. Confirm with ✅. Plain text, no HTML tags.
5. אל תשאל יותר משאלה אחת בהודעה.`;
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
  { name: 'log_health',         description: 'רשום כאב/שינה/מצב רוח ישירות ללא שאלון.', parameters: { type: 'object', properties: { pain: { type: 'number', description: '1-10 (חובה)' }, mood: { type: 'number' }, sleep: { type: 'number', description: 'שעות שינה' }, symptoms: { type: 'string' }, notes: { type: 'string' } }, required: ['pain'] } },
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
  // Social
  { name: 'save_social_draft',   description: 'שמור טיוטת פוסט לסושיאל מדיה.', parameters: { type: 'object', properties: { platform: { type: 'string', description: 'Instagram/Facebook/TikTok' }, content: { type: 'string' }, hashtags: { type: 'string' }, imagePrompt: { type: 'string' } }, required: ['platform', 'content'] } },
  { name: 'list_social_drafts',  description: 'הצג כל טיוטות הפוסטים.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'delete_social_draft', description: 'מחק טיוטת פוסט לפי ID.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

// ── Convert TOOL_DECLARATIONS → OpenAI/Groq format ───────────────────────────
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

      default:
        return `כלי לא מוכר: ${name}`;
    }
  } catch (err) {
    console.error(`[Agent] Tool error [${name}]:`, err.message);
    return `שגיאה בכלי ${name}: ${err.message}`;
  }
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

  // Build message array for Groq
  const chatMessages = [
    { role: 'system', content: buildSystemPrompt(memory) },
    ...toOpenAIHistory(messages),
    { role: 'user', content: text },
  ];

  let response;
  try {
    response = await callLLM(chatMessages, getAllToolDeclarations());
  } catch (err) {
    console.error('[Agent] FULL ERROR:', err.stack || err);
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
          response = await callLLM(chatMessages, getAllToolDeclarations());
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
        let args = {};
        try { args = JSON.parse(tc.function.arguments) ?? {}; } catch {}
        console.log('[Agent] Tool:', tc.function.name, JSON.stringify(args));
        const result = await executeAnyTool(tc.function.name, args, { bot, chatId });
        console.log('[Agent] Tool result:', String(result).substring(0, 200));
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
      response = await callLLM(chatMessages, getAllToolDeclarations());
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
