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
const { loadMemory, formatMemoryBlock, addLearnedFact, removeLearnedFact, listLearnedFacts } = require('./agent-memory');
const { addHabit, deleteHabit, logHabit, getHabits, formatHabits } = require('./habits');
const { initRegistry, getAllToolDeclarations, executeAnyTool } = require('./skills-registry');

// ── Retry helper ─────────────────────────────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Module imports ────────────────────────────────────────────────────────────
const { addTask, markDone, deleteTask, getOpenTasks, getCompletedToday } = require('./tasks');
const { logDirect, getTodayHealth, getWeekSummary, analyzeHealthPatterns } = require('./health');
const { getTodayMedStatus, markTaken }                                   = require('./medications');
const {
  addReminderDirect, listPending, deleteReminder, formatTimeIL,
} = require('./reminders');
const { addNote, searchNotes, load: loadNotes }         = require('./notes');
const { getDailyWordSync, formatWord, formatStreak }    = require('./english');
const { startPomo, stopPomo, getTodayPomoStats }        = require('./pomodoro');
const { sendNews }                                      = require('./news');
const { buildNewsMessage }                              = require('../skills/news');
const { load: loadSites, runChecks }                    = require('./sites');
const {
  getCalendarEvents, createCalendarEvent, getUnreadEmails,
  findEventsByQuery, updateCalendarEvent, deleteCalendarEvent,
  searchEmails, getEmailBody, scanEmailsForInvoices, sendEmail,
} = require('./google');
const { saveDraft, listDrafts, deleteDraft } = require('./social');
const { getExpenses, saveInvoice, getExpenseSummary, exportToCSV } = require('./expenses');
const { fetchStockPrice, formatPrice, addToWatchlist, removeFromWatchlist, formatWatchlist } = require('./stocks');
const { buildPainChartUrl, buildExpenseChartUrl, buildHabitChartUrl } = require('./charts');
const { generateQuote } = require('./quote-generator');

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
• יש לך גישה ל-Google Calendar וGmail — כששואלים על פגישות/יומן קרא ל-get_calendar_events, כששואלים "יש מיילים חדשים?" קרא ל-get_unread_emails, לחיפוש מיילים ספציפיים (חשבוניות, קבלות, מ-X, לפי נושא) — תמיד השתמש ב-search_emails ולא ב-get_unread_emails
• תזכורות: חשב בדיוק מהשעה הנ"ל
• שרשור: "כאב+תזכורת" → log_health → add_reminder
• 1-4 שורות, ✅, plain text, שאלה אחת מקסימום
• שיחת חולין: ענה בחום ללא כלים — שאל בחזרה, היה חבר
• כשהודעה מתחילה ב-[תמונה שנשלחה] — עיבדת תמונה בהצלחה דרך Vision AI, תאר מה ראית
• כשמשתמש אומר "תזכור ש..." — קרא ל-remember_fact עם העובדה
• הרגלים: כשמשתמש אומר "עשיתי X" / "סיימתי X" — אם X תואם הרגל רשום, סמן אוטומטית
• חדשות — ALWAYS קרא get_news מיד, אל תשאל אף פעם איזו קטגוריה:
  "חדשות" / "תביא לי חדשות" / "מה החדשות" → category='all'
  "חדשות AI" / "חדשות בינה מלאכותית" → category='ai'
  "חדשות שוק" / "מניות" / "שוק ההון" → category='market'
  "חדשות ישראל" / "סטארטאפים" → category='israel'
  "קריפטו" / "ביטקוין" / "חדשות קריפטו" → category='crypto'
  "CRPS" / "מחקר כאב" → category='crps'`;
}

// ── Tool definitions ──────────────────────────────────────────────────────────
// Descriptions kept to ≤15 words to minimize token usage (Groq: 100K/day budget).
const TOOL_DECLARATIONS = [
  // Tasks
  { name: 'add_task',       description: 'הוסף משימה חדשה לרשימה.', parameters: { type: 'object', properties: { text: { type: 'string' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['text'] } },
  { name: 'get_tasks',      description: 'קבל רשימת המשימות הפתוחות.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'complete_task',  description: 'סמן משימה כבוצעת לפי מספר.', parameters: { type: 'object', properties: { task_index: { type: 'number', description: '1-based' } }, required: ['task_index'] } },
  { name: 'delete_task',    description: 'מחק משימה לצמיתות.', parameters: { type: 'object', properties: { task_index: { type: 'number', description: '1-based' } }, required: ['task_index'] } },
  // Health Patterns (#24)
  { name: 'analyze_health_patterns', description: 'נתח דפוסי בריאות: כאב לפי יום, קורלציה שינה-כאב, מגמות.', parameters: { type: 'object', properties: { days: { type: 'number', description: 'ברירת מחדל: 30' } }, required: [] } },
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
  // News (production 4-category system)
  { name: 'get_news', description: 'הבא חדשות אישיות. ללא קטגוריה→all. "חדשות AI"→ai, "שוק"→market, "ישראל"→israel, "קריפטו"→crypto, "CRPS"→crps.', parameters: { type: 'object', properties: { category: { type: 'string', enum: ['ai','saas','market','israel','crps','crypto','all'], description: 'ברירת מחדל: all' } }, required: [] } },
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
  { name: 'get_unread_emails',     description: 'הצג מיילים חדשים שלא נקראו בלבד — לשאלות כמו "יש לי מיילים חדשים?", "מה יש לי במייל?". אל תשתמש לחיפוש לפי נושא/שולח/תוכן.', parameters: { type: 'object', properties: { maxResults: { type: 'number', description: 'ברירת מחדל: 5' }, query: { type: 'string', description: 'Gmail query למשל: has:attachment, from:X, subject:Y' } }, required: [] } },
  { name: 'get_email_body',        description: 'קרא תוכן מלא של מייל לפי ID — לסיכום או עיון.', parameters: { type: 'object', properties: { emailId: { type: 'string', description: 'ID מ-get_unread_emails' } }, required: ['emailId'] } },
  { name: 'search_emails',         description: 'חפש מיילים לפי קריטריונים — גם נקראים וגם לא נקראים. השתמש בכלי זה כשמחפשים: חשבוניות, קבלות, מיילים מאדם ספציפי, מיילים עם קבצים, מיילים לפי תאריך. דוגמאות: from:X, subject:חשבונית, has:attachment, newer_than:7d.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Gmail search: from:X, subject:Y, has:attachment, newer_than:7d' }, maxResults: { type: 'number' } }, required: ['query'] } },
  { name: 'send_email',            description: 'שלח מייל מהחשבון שלך. ציין נמען, נושא וגוף.', parameters: { type: 'object', properties: { to: { type: 'string', description: 'כתובת אימייל' }, subject: { type: 'string', description: 'נושא המייל' }, body: { type: 'string', description: 'תוכן המייל' } }, required: ['to', 'subject', 'body'] } },
  // PDF Quote Generator
  { name: 'generate_quote', description: 'צור הצעת מחיר PDF ושלח ללקוח.', parameters: { type: 'object', properties: { client_name: { type: 'string' }, project_description: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, price: { type: 'number' } }, required: ['description', 'price'] } }, currency: { type: 'string', enum: ['ILS', 'USD'], description: 'ברירת מחדל: ILS' }, notes: { type: 'string' } }, required: ['client_name', 'items'] } },
  // Charts (#34)
  { name: 'get_pain_chart',    description: 'שלח גרף כאב ומצב רוח כתמונה.', parameters: { type: 'object', properties: { days: { type: 'number', description: '7 או 30, ברירת מחדל: 7' } }, required: [] } },
  { name: 'get_expense_chart', description: 'שלח גרף הוצאות חודשי כתמונה.', parameters: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM' } }, required: [] } },
  { name: 'get_habit_chart',   description: 'שלח גרף רצף הרגלים כתמונה.', parameters: { type: 'object', properties: {}, required: [] } },
  // Stocks
  { name: 'get_stock_price', description: 'קבל מחיר מניה בזמן אמת + שינוי%.', parameters: { type: 'object', properties: { symbol: { type: 'string', description: 'סמל מניה: NVDA, AAPL, BTC-USD...' } }, required: ['symbol'] } },
  { name: 'watch_stock',     description: 'הוסף מניה לווצ\'ליסט עם התראת מחיר.', parameters: { type: 'object', properties: { symbol: { type: 'string' }, threshold: { type: 'number', description: 'מחיר להתראה' }, direction: { type: 'string', enum: ['above', 'below'], description: 'above=מעל, below=מתחת' } }, required: ['symbol', 'threshold'] } },
  { name: 'get_watchlist',   description: 'הצג ווצ\'ליסט מניות עם מחירים חיים.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'remove_stock',    description: 'הסר מניה מהווצ\'ליסט.', parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
  // Smart Memory (#23)
  { name: 'remember_fact',  description: 'שמור עובדה אישית בזיכרון לטווח ארוך.', parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
  { name: 'forget_fact',    description: 'מחק עובדה מהזיכרון לפי מספר.', parameters: { type: 'object', properties: { index: { type: 'number', description: '0-based' } }, required: ['index'] } },
  { name: 'get_memory',     description: 'הצג את כל העובדות השמורות בזיכרון.', parameters: { type: 'object', properties: {}, required: [] } },
  // Habit Tracker (#35)
  { name: 'add_habit',    description: 'הוסף הרגל חדש למעקב יומי/שבועי.', parameters: { type: 'object', properties: { name: { type: 'string' }, icon: { type: 'string', description: 'אמוג\'י כרצון' }, frequency: { type: 'string', enum: ['daily', 'weekly'] } }, required: ['name'] } },
  { name: 'log_habit',    description: 'סמן הרגל כבוצע היום.', parameters: { type: 'object', properties: { id: { type: 'number' }, done: { type: 'boolean', description: 'ברירת מחדל: true' } }, required: ['id'] } },
  { name: 'get_habits',   description: 'הצג כל ההרגלים עם streak וסטטוס היום.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'delete_habit', description: 'מחק הרגל לפי ID.', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  // Rate Limit
  { name: 'get_rate_stats', description: 'הצג מצב מכסת API: Gemini, Groq, כללי.', parameters: { type: 'object', properties: {}, required: [] } },
  // Social
  { name: 'save_social_draft',   description: 'שמור טיוטת פוסט לסושיאל מדיה.', parameters: { type: 'object', properties: { platform: { type: 'string', description: 'Instagram/Facebook/TikTok' }, content: { type: 'string' }, hashtags: { type: 'string' }, imagePrompt: { type: 'string' } }, required: ['platform', 'content'] } },
  { name: 'list_social_drafts',  description: 'הצג כל טיוטות הפוסטים.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'delete_social_draft', description: 'מחק טיוטת פוסט לפי ID.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  // Expenses
  { name: 'get_expenses',          description: 'הצג קבלות/הוצאות שנסרקו מתמונות.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'get_monthly_expenses',  description: 'הצג סיכום הוצאות חודשי עם כל החשבוניות.', parameters: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM, ברירת מחדל: חודש נוכחי' } }, required: [] } },
  { name: 'export_expenses_csv',   description: 'ייצא הוצאות לקובץ CSV ושלח בטלגרם.', parameters: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM, ברירת מחדל: חודש נוכחי' } }, required: [] } },
  { name: 'scan_invoice_emails',   description: 'סרוק Gmail לחשבוניות חדשות (30 ימים אחרונים) ושמור אוטומטית.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'add_manual_expense',    description: 'הוסף הוצאה ידנית: הוצאתי X על Y.', parameters: { type: 'object', properties: { vendor: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string', description: 'ILS/USD/EUR' }, category: { type: 'string', description: 'tech/food/health/office/other' }, description: { type: 'string' } }, required: ['vendor', 'amount'] } },
];

// ── Split tools: CORE (always sent) vs EXTENDED (sent only when relevant) ────
const CORE_TOOL_NAMES = new Set([
  'get_tasks', 'add_task', 'complete_task', 'delete_task',
  'log_health', 'get_health_today',
  'add_reminder', 'get_reminders',
  'get_current_context',
  'get_rate_stats',
  'get_expenses',
  'remember_fact', 'get_memory',
  'get_habits', 'log_habit', 'add_habit',
  'get_news',
  'get_stock_price', 'get_watchlist',
]);

const EXTENDED_KEYWORDS = [
  'news', 'חדשות', 'שוק', 'מניות', 'סטארטאפ', 'ישראל טק', 'ai news', 'saas', 'market',
  'crps', 'כאב', 'מחקר', 'קריפטו', 'crypto', 'bitcoin', 'ביטקוין', 'web3',
  'מניה', 'מניות', 'stock', 'stocks', 'nvda', 'aapl', 'tsla', 'מחיר', 'ווצ\'ליסט', 'watchlist',
  'גרף', 'chart', 'גרפים', 'pain chart', 'expense chart',
  'הצעת מחיר', 'quote', 'pdf', 'לקוח', 'חשבון', 'invoice',
  'english', 'אנגלית', 'מילה', 'streak',
  'pomodoro', 'פומודורו', 'טיימר',
  'sites', 'אתרים', 'אתר',
  'calendar', 'יומן', 'אירוע', 'פגישה', 'פגישות', 'עדכן פגישה',
  'email', 'מייל', 'אימייל', 'gmail', 'inbox', 'תסכם מייל', 'שלח מייל', 'תשלח מייל', 'שליחת מייל', 'תשלח', 'חפש מייל', 'מצא מייל',
  'social', 'פוסט', 'instagram', 'facebook', 'tiktok',
  'notes', 'הערות', 'הערה', 'חפש',
  'health summary', 'סיכום בריאות',
  'דפוסים', 'patterns', 'ניתוח בריאות', 'ניתוח', 'קורלציה',
  'זכור', 'תזכור', 'remember', 'שכח', 'זיכרון', 'עובדות',
  'הרגל', 'הרגלים', 'habit', 'habits', 'streak', 'רצף',
  'medications', 'תרופות', 'med',
  'pomodoro stats',
  // Web search triggers
  'חיפוש', 'search', 'מחיר', 'כמה עולה', 'מה זה', 'תחפש', 'תבדוק', 'מה המחיר',
  // OCR triggers
  'סרוק', 'ocr', 'חלץ טקסט', 'קבלה', 'מרשם', 'כרטיס ביקור',
  // Invoice/receipt email search + expense tracking
  'חשבונית', 'חשבוניות', 'קבלות', 'invoice',
  'הוצאות', 'סיכום חודשי', 'כמה הוצאתי', 'ייצא', 'export', 'csv', 'הוצאתי',
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

      // ── News (4-category production system) ───────────────────────────────
      case 'get_news': {
        const category = args.category || 'all';
        const msg = await buildNewsMessage(category, { ignoreDedup: true });
        await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
        return `חדשות נשלחו (${category})`;
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
      case 'get_unread_emails':      return await getUnreadEmails(Number(args.maxResults) || 5, args.query || '');
      case 'get_email_body':         return await getEmailBody(args.emailId);
      case 'search_emails':          return await searchEmails(args.query, Number(args.maxResults) || 10);
      case 'send_email':             return await sendEmail(args.to, args.subject, args.body);

      // ── Social ─────────────────────────────────────────────────────────────
      case 'save_social_draft':   return saveDraft(args);
      case 'list_social_drafts':  return listDrafts();
      case 'delete_social_draft': return deleteDraft(args.id);

      // ── Expenses ───────────────────────────────────────────────────────────
      case 'get_expenses': {
        const exps = getExpenses();
        if (!exps.length) return 'אין קבלות שמורות עדיין';
        return exps.slice(0, 20).map(e =>
          `#${e.id}: ${e.vendor || e.store || '?'} | ${e.amount || '?'} ${e.currency || 'ILS'} | ${e.date || '?'}`
        ).join('\n');
      }

      case 'get_monthly_expenses': {
        return getExpenseSummary(args.month || null);
      }

      case 'export_expenses_csv': {
        const csvPath = exportToCSV(args.month || null);
        const { existsSync } = require('fs');
        console.log('[CSV] file path:', csvPath, 'exists:', existsSync(csvPath));
        return `__FILE__:${csvPath}`;
      }

      case 'scan_invoice_emails': {
        const invoices = await scanEmailsForInvoices(10);
        if (!invoices.length) return 'לא נמצאו חשבוניות/קבלות ב-30 ימים האחרונים.';
        const existing = getExpenses();
        const existingIds = new Set(existing.map(e => e.emailId).filter(Boolean));
        let saved = 0;
        for (const inv of invoices) {
          if (existingIds.has(inv.emailId)) continue; // already saved
          const month = inv.date ? (() => {
            try { const d = new Date(inv.date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; } catch { return null; }
          })() : null;
          saveInvoice({
            vendor: inv.vendor, source: 'email', emailId: inv.emailId,
            description: inv.subject, month,
            date: inv.date ? new Date(inv.date).toISOString().split('T')[0] : null,
            amount: inv.amount || null,
            currency: inv.currency || 'ILS',
          });
          saved++;
        }
        return `✅ נסרקו ${invoices.length} מיילים, נשמרו ${saved} חשבוניות.\n` +
          invoices.slice(0, 5).map(i =>
            `• ${i.vendor}${i.amount ? ` — ${i.amount} ${i.currency}` : ''} — ${i.subject}`
          ).join('\n');
      }

      case 'add_manual_expense': {
        const entry = saveInvoice({
          vendor:      args.vendor,
          amount:      args.amount,
          currency:    args.currency || 'ILS',
          category:    args.category || 'other',
          description: args.description || null,
          source:      'manual',
        });
        return `✅ הוצאה נשמרה #${entry.id}: ${entry.vendor} — ${entry.amount} ${entry.currency}`;
      }

      // ── PDF Quote Generator ───────────────────────────────────────────────
      case 'generate_quote': {
        const pdfPath = await generateQuote({
          clientName:         args.client_name,
          projectDescription: args.project_description || '',
          items:              args.items || [],
          currency:           args.currency || 'ILS',
          notes:              args.notes || '',
        });
        return `__FILE__:${pdfPath}`;
      }

      // ── Charts (#34) ──────────────────────────────────────────────────────
      case 'get_pain_chart': {
        const url = buildPainChartUrl(Number(args.days) || 7);
        if (!url) return 'אין מספיק נתוני בריאות לגרף. תיעד לפחות 2 ימים.';
        await bot.sendPhoto(chatId, url, { caption: `📊 גרף כאב — ${Number(args.days) || 7} ימים` });
        return '__CHART_SENT__';
      }
      case 'get_expense_chart': {
        const url = buildExpenseChartUrl(args.month || null);
        if (!url) return 'אין הוצאות לתקופה זו.';
        await bot.sendPhoto(chatId, url, { caption: `📊 גרף הוצאות` });
        return '__CHART_SENT__';
      }
      case 'get_habit_chart': {
        const url = buildHabitChartUrl();
        if (!url) return 'אין הרגלים להציג. הוסף הרגל תחילה.';
        await bot.sendPhoto(chatId, url, { caption: '📊 רצף הרגלים' });
        return '__CHART_SENT__';
      }

      // ── Stocks ────────────────────────────────────────────────────────────
      case 'get_stock_price': {
        const s = await fetchStockPrice(args.symbol);
        return formatPrice(s);
      }
      case 'watch_stock': {
        const w = addToWatchlist(chatId, args.symbol, args.threshold, args.direction || 'above');
        const dir = (args.direction || 'above') === 'above' ? 'מעל' : 'מתחת ל';
        return `✅ עוקב אחרי ${w.symbol} — התראה כש${dir} $${w.threshold}`;
      }
      case 'get_watchlist': {
        return await formatWatchlist(chatId);
      }
      case 'remove_stock': {
        const ok = removeFromWatchlist(chatId, args.symbol);
        return ok ? `✅ ${args.symbol.toUpperCase()} הוסר מהווצ'ליסט` : `${args.symbol.toUpperCase()} לא נמצא בווצ'ליסט`;
      }

      // ── Health Patterns (#24) ──────────────────────────────────────────────
      case 'analyze_health_patterns': {
        const days = Number(args.days) || 30;
        return analyzeHealthPatterns(days);
      }

      // ── Smart Memory (#23) ─────────────────────────────────────────────────
      case 'remember_fact': {
        const facts = addLearnedFact(chatId, args.fact);
        return `✅ נשמר בזיכרון: "${args.fact}" (סה"כ ${facts.length} עובדות)`;
      }
      case 'forget_fact': {
        const ok = removeLearnedFact(chatId, Number(args.index));
        return ok ? `✅ עובדה #${args.index} נמחקה מהזיכרון` : `שגיאה: אינדקס ${args.index} לא קיים`;
      }
      case 'get_memory': {
        const facts = listLearnedFacts(chatId);
        if (!facts.length) return 'אין עובדות שמורות בזיכרון עדיין.';
        return '🧠 <b>זיכרון אישי:</b>\n' + facts.map((f, i) => `${i}. ${f.fact}`).join('\n');
      }

      // ── Habit Tracker (#35) ────────────────────────────────────────────────
      case 'add_habit': {
        const habit = addHabit(args.name, args.icon, args.frequency);
        return `✅ הרגל נוסף: ${habit.icon} "${habit.name}" (ID: ${habit.id}, ${habit.frequency})`;
      }
      case 'log_habit': {
        const result = logHabit(Number(args.id), args.done !== false);
        if (!result) return `שגיאה: הרגל ${args.id} לא נמצא`;
        const { habit, streak } = result;
        return `${args.done !== false ? '✅' : '❌'} ${habit.icon} "${habit.name}" — ${streak > 0 ? `🔥 רצף ${streak} ימים` : 'נרשם'}`;
      }
      case 'get_habits': {
        return formatHabits();
      }
      case 'delete_habit': {
        const removed = deleteHabit(Number(args.id));
        if (!removed) return `שגיאה: הרגל ${args.id} לא נמצא`;
        return `🗑️ הרגל "${removed.name}" נמחק`;
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

    // ── If a tool returned a file path, send it directly without another LLM call ──
    const fileResult = toolResults.find(r => r.content?.startsWith('__FILE__:'));
    if (fileResult) {
      const filePath = fileResult.content.slice('__FILE__:'.length).trim();
      console.log('[Agent] FILE result detected, returning path:', filePath);
      addMessage(chatId, 'model', fileResult.content);
      return fileResult.content;
    }

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
