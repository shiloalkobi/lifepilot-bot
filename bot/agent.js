'use strict';

const fs   = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { canCall, increment }           = require('./rate-limiter');
const { getHistory, addMessage }       = require('./history');
const { loadMemory, formatMemoryBlock } = require('./agent-memory');

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

console.log('[Agent] Gemini key present:', !!process.env.GEMINI_API_KEY);
const gemini = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});
const GEMINI_MODEL = 'gemini-2.5-flash';

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
  return `אתה LifePilot — העוזר האישי של שילה אלקובי.
אזור זמן: Asia/Jerusalem | עכשיו: ${nowIL()} | יום: ${getDayHebrew()}

## פרופיל שילה
שם: שילה אלקובי | גר בראשון לציון | מפתח עצמאי, Node.js/WordPress/AI
בריאות: CRPS ברגל שמאל מאז 2018, שתל DRG — כאב כרוני, ניהול יומי
מטרות: בניית מוצרי AI, SaaS, אוטומציה
${shiloProfile ? '\n' + shiloProfile.slice(0, 800) : ''}

## זיכרון
${memBlock}

## כללי שימוש בכלים — CRITICAL
- קרא לכלים לפני שאתה מגיב — קבל נתונים אמיתיים, לא תשמור מידע
- לפעולות כתיבה (add_task, log_health, add_reminder, save_note): אשר מה בוצע אחרי הכלי
- לפעולות קריאה (get_tasks, get_health_today): קרא קודם, תגיב על הנתונים
- שרשר כלים אם הבקשה דורשת זאת — "יש לי כאב ראש תזכיר לי לקחת תרופה" = log_health + add_reminder
- NEVER תמציא נתונים — אם לא יודע, קרא לכלי הנכון
- לחישוב זמן ב-add_reminder: השתמש בשעה הנוכחית ${nowIL()} ועשה חשבון

## זיהוי כוונה
TASKS: "צריך לעשות X" / "תוסיף משימה" / "אל תשכח" → add_task
       "מה יש לי לעשות" / "רשימת משימות" → get_tasks
       "סיימתי" / "עשיתי" / "הושלם" → complete_task
HEALTH: "כאב X" / "הכאב היום" / "לא מרגיש טוב" → log_health
        "מה המצב הבריאותי" → get_health_today
        "לקחתי [תרופה]" → mark_med_taken
        "מה נשאר לקחת" / "אילו תרופות" → get_med_status
REMINDERS: "תזכיר לי" / "remind me" / "בעוד X זמן" → add_reminder
NOTES: "תשמור" / "תרשום" / "note:" → save_note
       "חפש הערה" → search_notes
ENGLISH: "מה המילה היום" / "מילה באנגלית" → get_daily_word
FOCUS: "פומודורו" / "בוא נעבוד" / "25 דקות" → start_pomodoro
       "עצור טיימר" → stop_pomodoro
CONTEXT: "מה המצב שלי" / "איך אני עומד" → get_current_context קודם

## פורמט תשובה
- קצר וישיר (1-4 שורות לרוב)
- HTML: <b>bold</b> לכותרות, <i>italic</i> לפרטים
- אישורים: "✅ [מה בוצע]"
- עברית ברורה, לא רובוטית
- אל תשאל יותר משאלה אחת בהודעה`;
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOL_DECLARATIONS = [
  // Tasks
  {
    name: 'add_task',
    description: 'הוסף משימה חדשה לרשימה. כשהמשתמש אומר שצריך לעשות משהו, לזכור משהו, או מבקש להוסיף משימה.',
    parameters: {
      type: 'object',
      properties: {
        text:     { type: 'string', description: 'תיאור המשימה' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'עדיפות. high = דחוף, medium = רגיל. ברירת מחדל: medium' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_tasks',
    description: 'קבל את רשימת המשימות הפתוחות הנוכחית. כשהמשתמש שואל מה יש לו לעשות.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'complete_task',
    description: 'סמן משימה כבוצעת לפי מספר רץ. כשהמשתמש אומר שסיים משימה.',
    parameters: {
      type: 'object',
      properties: {
        task_index: { type: 'number', description: 'מספר המשימה (1-based) מהרשימה' },
      },
      required: ['task_index'],
    },
  },
  {
    name: 'delete_task',
    description: 'מחק משימה מהרשימה לצמיתות.',
    parameters: {
      type: 'object',
      properties: {
        task_index: { type: 'number', description: 'מספר המשימה (1-based)' },
      },
      required: ['task_index'],
    },
  },
  // Health
  {
    name: 'log_health',
    description: 'רשום דיווח בריאות ישיר (ללא שאלון אינטראקטיבי). כשהמשתמש מזכיר כאב, שינה, מצב רוח, או תסמינים.',
    parameters: {
      type: 'object',
      properties: {
        pain:     { type: 'number', description: 'רמת כאב 1-10. חובה. "כאב חזק"→8, "קצת כאב"→4, "ללא כאב"→1' },
        mood:     { type: 'number', description: 'מצב רוח 1-10. אופציונלי.' },
        sleep:    { type: 'number', description: 'שעות שינה אמש. אופציונלי.' },
        symptoms: { type: 'string', description: 'תסמינים פיזיים. אופציונלי.' },
        notes:    { type: 'string', description: 'הערות חופשיות. אופציונלי.' },
      },
      required: ['pain'],
    },
  },
  {
    name: 'get_health_today',
    description: 'קבל את דיווח הבריאות של היום. לבדוק אם דיווח כבר, או להציג מצב נוכחי.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_health_summary',
    description: 'קבל סיכום בריאות עבור N ימים אחרונים. לניתוח מגמות, "איך הבריאות השבוע".',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'מספר ימים אחורה. ברירת מחדל: 7' },
      },
      required: [],
    },
  },
  // Medications
  {
    name: 'get_med_status',
    description: 'קבל סטטוס תרופות היום — מה נלקח, ממתין, דולג. כשהמשתמש שואל על תרופות.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'mark_med_taken',
    description: 'סמן תרופה כנלקחה. כשהמשתמש אומר שלקח תרופה.',
    parameters: {
      type: 'object',
      properties: {
        medication_name: { type: 'string', description: 'שם התרופה (לא תלוי רישיות)' },
      },
      required: ['medication_name'],
    },
  },
  // Reminders
  {
    name: 'add_reminder',
    description: 'קבע תזכורת לזמן מסוים. כשהמשתמש אומר "תזכיר לי", "remind me", או מציין זמן עתידי. חשב את remind_at מהזמן הנוכחי.',
    parameters: {
      type: 'object',
      properties: {
        task:      { type: 'string', description: 'על מה להזכיר' },
        remind_at: { type: 'string', description: `ISO 8601 datetime בשעון ישראל. חשב מ-${nowIL()}. "בעוד שעה"=+1h, "בעוד 30 דקות"=+30m, "מחר ב-9"=מחר 09:00` },
      },
      required: ['task', 'remind_at'],
    },
  },
  {
    name: 'get_reminders',
    description: 'הצג את כל התזכורות הממתינות.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'delete_reminder',
    description: 'מחק תזכורת ממתינת לפי ID.',
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'number', description: 'ID התזכורת' },
      },
      required: ['reminder_id'],
    },
  },
  // Notes
  {
    name: 'save_note',
    description: 'שמור הערה או snippet. כשהמשתמש רוצה לשמור מידע, קוד, רעיון, או לינק לשימוש מאוחר יותר.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'תוכן ההערה המלא' },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_notes',
    description: 'חפש בהערות השמורות לפי מילת מפתח.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'מילה לחיפוש' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_recent_notes',
    description: 'קבל את ההערות האחרונות.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'כמה הערות. ברירת מחדל: 5' },
      },
      required: [],
    },
  },
  // English
  {
    name: 'get_daily_word',
    description: 'קבל את מילת האנגלית של היום. כשהמשתמש שואל על המילה היומית או רוצה ללמוד.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_english_stats',
    description: 'קבל סטטיסטיקת לימוד אנגלית — streak, ניקוד, ימי תרגול.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  // Pomodoro
  {
    name: 'start_pomodoro',
    description: 'התחל סשן פומודורו. כשהמשתמש רוצה להתמקד, לעבוד, או מזכיר טיימר.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'אורך הסשן בדקות. ברירת מחדל: 25' },
      },
      required: [],
    },
  },
  {
    name: 'stop_pomodoro',
    description: 'עצור את סשן הפומודורו הנוכחי.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pomodoro_stats',
    description: 'קבל סטטיסטיקת פומודורו של היום.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  // News
  {
    name: 'get_tech_news',
    description: 'שלח חדשות טכנולוגיה מ-Hacker News. כשהמשתמש שואל על חדשות, tech news.',
    parameters: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'true=10 כתבות עם קישורים, false=5 עם סיכום AI' },
      },
      required: [],
    },
  },
  // Sites
  {
    name: 'get_site_status',
    description: 'הצג סטטוס של כל האתרים במעקב.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'check_sites_now',
    description: 'בצע בדיקת up/down מיידית לכל האתרים.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  // Context
  {
    name: 'get_current_context',
    description: 'קבל סנפשוט של המצב הנוכחי — משימות, בריאות, תרופות, תזכורות, פומודורו. השתמש בתחילת בקשות מורכבות.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  // Calendar
  {
    name: 'get_calendar_events',
    description: 'מביא אירועים מ-Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '1=היום, 7=השבוע. ברירת מחדל: 7' },
      },
      required: [],
    },
  },
  {
    name: 'find_calendar_events',
    description: 'מחפש אירוע ביומן לפי שם. השתמש לפני עדכון/מחיקה.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'שם האירוע (חלקי)' },
        days:  { type: 'number', description: 'כמה ימים קדימה. ברירת מחדל: 30' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'יוצר אירוע חדש ב-Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        summary:       { type: 'string', description: 'שם האירוע' },
        startDateTime: { type: 'string', description: 'ISO 8601 שעת התחלה' },
        endDateTime:   { type: 'string', description: 'ISO 8601 שעת סיום' },
      },
      required: ['summary', 'startDateTime', 'endDateTime'],
    },
  },
  {
    name: 'update_calendar_event',
    description: 'מעדכן אירוע קיים. יש לקרוא find_calendar_events קודם.',
    parameters: {
      type: 'object',
      properties: {
        eventId:       { type: 'string', description: 'ID של האירוע' },
        summary:       { type: 'string', description: 'שם חדש (אופציונלי)' },
        startDateTime: { type: 'string', description: 'שעת התחלה חדשה ISO 8601 (אופציונלי)' },
        endDateTime:   { type: 'string', description: 'שעת סיום חדשה ISO 8601 (אופציונלי)' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'מוחק אירוע מ-Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'ID האירוע' },
        summary: { type: 'string', description: 'שם האירוע (לאישור)' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'get_unread_emails',
    description: 'מביא מיילים שלא נקראו מ-Gmail.',
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'כמה מיילים. ברירת מחדל: 5' },
      },
      required: [],
    },
  },
  // Social
  {
    name: 'save_social_draft',
    description: 'שמור טיוטת פוסט לסושיאל מדיה.',
    parameters: {
      type: 'object',
      properties: {
        platform:    { type: 'string', description: 'Instagram / Facebook / TikTok' },
        content:     { type: 'string', description: 'טקסט הפוסט' },
        hashtags:    { type: 'string', description: 'האשטגים (אופציונלי)' },
        imagePrompt: { type: 'string', description: 'prompt לתמונה (אופציונלי)' },
      },
      required: ['platform', 'content'],
    },
  },
  {
    name: 'list_social_drafts',
    description: 'הצג כל טיוטות הפוסטים השמורות.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'delete_social_draft',
    description: 'מחק טיוטת פוסט לפי ID.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID הטיוטה' },
      },
      required: ['id'],
    },
  },
];

// ── Convert TOOL_DECLARATIONS → OpenAI/Groq format ───────────────────────────
const TOOLS = TOOL_DECLARATIONS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args, ctx) {
  const { bot, chatId } = ctx;
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

// ── Convert history to OpenAI format ─────────────────────────────────────────
function toOpenAIHistory(messages) {
  // All messages except the last (which is the current user message)
  return messages.slice(0, -1).map(m => ({
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
    response = await gemini.chat.completions.create({
      model:       GEMINI_MODEL,
      messages:    chatMessages,
      tools:       TOOLS,
      tool_choice: 'auto',
      temperature: 0.7,
    });
  } catch (err) {
    console.error('[Agent] FULL ERROR:', err.stack || err);
    if (err.status === 429 || err.message?.includes('429')) {
      const reply = '⏳ הגבלת קריאות API — נסה שוב בעוד כמה דקות.';
      addMessage(chatId, 'model', reply);
      return reply;
    }
    throw err;
  }
  console.log('[Agent] Gemini finish_reason:', response.choices[0]?.finish_reason);
  console.log('[Agent] Full message:', JSON.stringify(response.choices[0].message));

  // Add assistant message to history buffer
  chatMessages.push(response.choices[0].message);

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
        const result = await executeTool(tc.function.name, args, { bot, chatId });
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
      response = await gemini.chat.completions.create({
        model:       GEMINI_MODEL,
        messages:    chatMessages,
        tools:       TOOLS,
        tool_choice: 'auto',
        temperature: 0.7,
      });
      console.log('[Agent] Gemini finish_reason:', response.choices[0]?.finish_reason);
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

  const reply = response.choices[0]?.message?.content || 'סליחה, לא הצלחתי לעבד את הבקשה.';
  console.log('[Agent] REPLY:', reply);
  addMessage(chatId, 'model', reply);
  return reply;
}

module.exports = { handleMessage };
