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
const { savePassword, getPassword, listPasswords, deletePassword } = require('./password-manager');
const { generateTTS } = require('./tts');

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
function buildSystemPrompt(memory, chatId) {
  const memBlock = formatMemoryBlock(memory);
  const nowDisplay = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

  // Time-of-day context
  const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }), 10);
  const timeCtx = hour < 10
    ? 'בוקר — תשובות קצרות וממוקדות'
    : hour < 15
    ? 'צהריים — תשובות רגילות'
    : hour < 20
    ? 'אחר הצהריים — תשובות מפורטות יותר אם נחוץ'
    : 'ערב — תשובות ידידותיות ורגועות';

  // Pain context
  let painCtx = '';
  try {
    const h = getTodayHealth();
    if (h && h.painLevel >= 7) painCtx = `⚠️ כאב גבוה היום (${h.painLevel}/10) — היה קצר, עדין ואמפתי`;
  } catch {}

  // Recent topics
  let topicsCtx = '';
  try {
    const topics = (memory.context?.recentTopics || []).slice(-3);
    if (topics.length) topicsCtx = `דיברנו לאחרונה על: ${topics.join(', ')}`;
  } catch {}

  return `LifePilot — עוזר של שילה (גבר, זכר בלבד) | ישראל
זמן: ${nowDisplay} | ${nowIL()} | ${getDayHebrew()} | ${timeCtx}
CRPS רגל שמאל (DRG) — כאב כרוני
${painCtx ? painCtx + '\n' : ''}${topicsCtx ? topicsCtx + '\n' : ''}${memBlock ? 'זיכרון:\n' + memBlock + '\n' : ''}
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

// ── Save recent topic to memory ───────────────────────────────────────────────
function saveRecentTopic(chatId, text) {
  try {
    const { loadMemory, saveMemory } = require('./agent-memory');
    const memory = loadMemory(chatId);
    if (!memory.context) memory.context = {};
    if (!Array.isArray(memory.context.recentTopics)) memory.context.recentTopics = [];
    // Extract a short topic label (first 5 words, no commands)
    const topic = text.replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).slice(0, 5).join(' ');
    if (topic.length < 3) return;
    // Keep only last 5 unique topics
    memory.context.recentTopics = [
      ...memory.context.recentTopics.filter(t => t !== topic).slice(-4),
      topic,
    ];
    saveMemory(chatId, memory);
  } catch {} // never crash the main flow
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
  // Market Research (#38)
  { name: 'market_research', description: 'חקור שוק/מתחרה/תחום עסקי — מחזיר דוח מובנה: סקירה, מתחרים, תמחור.', parameters: { type: 'object', properties: { topic: { type: 'string', description: 'נושא/חברה/תחום לחקירה' }, language: { type: 'string', enum: ['he','en'], description: 'שפת הדוח' } }, required: ['topic'] } },
  // Password Manager (#40)
  { name: 'save_password',   description: 'שמור סיסמה מוצפנת לשירות.', parameters: { type: 'object', properties: { service: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' } }, required: ['service', 'password'] } },
  { name: 'get_password',    description: 'שלוף סיסמה לשירות ספציפי.', parameters: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] } },
  { name: 'list_passwords',  description: 'הצג רשימת שירותים עם סיסמאות (שמות בלבד, ללא הסיסמאות עצמן).', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'delete_password', description: 'מחק סיסמה של שירות.', parameters: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] } },
  // TTS (#11)
  { name: 'voice_reply', description: 'שלח תשובה קולית (MP3). השתמש כשמבקשים "ענה בקול/דיבור/קולי/voice".', parameters: { type: 'object', properties: { text: { type: 'string', description: 'הטקסט לאמירה (עד 200 תווים)' }, lang: { type: 'string', description: 'iw=עברית en=אנגלית', enum: ['iw','en','ar'] } }, required: ['text'] } },
  // Content Writing (#30)
  { name: 'write_content', description: 'כתוב תוכן: פוסט לאינסטגרם/פייסבוק, מייל ללקוח, ביו, כותרת.', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['instagram','facebook','email','bio','headline','whatsapp'] }, topic: { type: 'string' }, tone: { type: 'string', enum: ['professional','casual','funny','inspirational'] }, language: { type: 'string', enum: ['he','en'] } }, required: ['type','topic'] } },
  // Code Generation (#31)
  { name: 'generate_code', description: 'כתוב קוד לפי בקשה ושלח כקובץ או טקסט.', parameters: { type: 'object', properties: { description: { type: 'string' }, language: { type: 'string', enum: ['javascript','python','bash','html','css','sql'] }, send_as_file: { type: 'boolean' } }, required: ['description'] } },
  // Form Generator (#28)
  { name: 'generate_form', description: 'צור טופס HTML מותאם אישית ושלח כקובץ.', parameters: { type: 'object', properties: { title: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, submit_text: { type: 'string' } }, required: ['title','fields'] } },
  // Presentation Generator (#29)
  { name: 'generate_presentation', description: 'צור מצגת HTML עם שקפים על נושא נתון.', parameters: { type: 'object', properties: { title: { type: 'string' }, topic: { type: 'string' }, slides_count: { type: 'number' }, language: { type: 'string', enum: ['he','en'] } }, required: ['title','topic'] } },
  // Landing Page Generator (#27)
  { name: 'generate_landing_page', description: 'צור דף נחיתה HTML מקצועי לעסק או מוצר.', parameters: { type: 'object', properties: { business_name: { type: 'string' }, description: { type: 'string' }, services: { type: 'array', items: { type: 'string' } }, cta_text: { type: 'string' }, color: { type: 'string', enum: ['blue','green','purple','orange','dark'] } }, required: ['business_name'] } },
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
  'list_passwords',
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
  // Market research
  'מחקר שוק', 'תחקור', 'מתחרים', 'מתחרה', 'market research', 'competitor',
  // TTS
  'ענה בקול', 'תדבר', 'קולי', 'voice', 'קול', 'דיבור', 'audio',
  // Password
  'סיסמה', 'סיסמאות', 'password', 'passwords',
  // Web search triggers
  'חיפוש', 'search', 'מחיר', 'כמה עולה', 'מה זה', 'תחפש', 'תבדוק', 'מה המחיר',
  // OCR triggers
  'סרוק', 'ocr', 'חלץ טקסט', 'קבלה', 'מרשם', 'כרטיס ביקור',
  // Invoice/receipt email search + expense tracking
  'חשבונית', 'חשבוניות', 'קבלות', 'invoice',
  'הוצאות', 'סיכום חודשי', 'כמה הוצאתי', 'ייצא', 'export', 'csv', 'הוצאתי',
  // Dashboard
  'דשבורד', 'dashboard',
  // Content Writing (#30)
  'פוסט', 'תוכן', 'מייל ללקוח', 'ביו', 'כתוב לי', 'content', 'כותרת', 'כתיבה',
  // Code Generation (#31)
  'קוד', 'סקריפט', 'כתוב קוד', 'תכתוב', 'script', 'code',
  // Form Generator (#28)
  'טופס', 'form', 'הרשמה', 'צור טופס',
  // Presentation (#29)
  'מצגת', 'שקפים', 'presentation', 'slides',
  // Landing Page (#27)
  'דף נחיתה', 'landing page', 'landing',
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

      // ── Market Research (#38) ─────────────────────────────────────────────
      case 'market_research': {
        const topic = (args.topic || '').trim();
        if (!topic) return 'נא לציין נושא לחקירה.';
        const queries = [
          `${topic} market overview trends 2024 2025`,
          `${topic} top competitors comparison`,
          `${topic} pricing business model revenue`,
        ];
        bot.sendMessage(chatId, `🔍 מחקר שוק: <b>${topic}</b>\nמחפש מידע...`, { parse_mode: 'HTML' });
        const [overview, competitors, pricing] = await Promise.all(
          queries.map(q => executeAnyTool('web_search', { query: q }, ctx).catch(() => 'לא נמצא מידע'))
        );
        return [
          `📊 <b>מחקר שוק: ${topic}</b>\n`,
          `<b>🌐 סקירת שוק:</b>\n${overview}`,
          `<b>🏢 מתחרים עיקריים:</b>\n${competitors}`,
          `<b>💰 תמחור ומודל עסקי:</b>\n${pricing}`,
          `\n💡 <i>הדוח מבוסס על חיפוש אינטרנט בזמן אמת</i>`,
        ].join('\n\n');
      }

      // ── Password Manager (#40) ────────────────────────────────────────────
      case 'save_password': {
        savePassword(args.service, args.username || '', args.password);
        return `🔐 סיסמה נשמרה: <b>${args.service}</b>${args.username ? ` (${args.username})` : ''}`;
      }
      case 'get_password': {
        const entry = getPassword(args.service);
        if (!entry) return `❌ לא נמצאה סיסמה עבור "${args.service}"`;
        return `🔑 <b>${entry.service}</b>${entry.username ? `\n👤 ${entry.username}` : ''}\n🔒 <code>${entry.password}</code>`;
      }
      case 'list_passwords': {
        const list = listPasswords();
        if (!list.length) return '🔐 אין סיסמאות שמורות.';
        return '🔐 <b>סיסמאות שמורות:</b>\n' + list.map((e, i) => `${i+1}. ${e.service}${e.username ? ` — ${e.username}` : ''}`).join('\n');
      }
      case 'delete_password': {
        const ok = deletePassword(args.service);
        return ok ? `🗑️ סיסמת <b>${args.service}</b> נמחקה` : `❌ לא נמצאה סיסמה עבור "${args.service}"`;
      }

      // ── TTS (#11) ─────────────────────────────────────────────────────────
      case 'voice_reply': {
        const ttsText = (args.text || '').slice(0, 200);
        const ttsLang = args.lang || 'iw';
        const mp3Path = await generateTTS(ttsText, ttsLang);
        await bot.sendVoice(chatId, require('fs').createReadStream(mp3Path));
        return '__AUDIO_SENT__';
      }

      // ── Content Writing (#30) ─────────────────────────────────────────────
      case 'write_content': {
        const contentType = args.type || 'instagram';
        const topic       = args.topic || '';
        const tone        = args.tone || 'professional';
        const lang        = args.language || 'he';
        const langLabel   = lang === 'he' ? 'Hebrew' : 'English';

        const typePrompts = {
          instagram: `Write an Instagram post in ${langLabel} about: "${topic}". Tone: ${tone}. Include relevant emojis throughout the text and add 10-15 relevant hashtags at the end.`,
          facebook:  `Write a Facebook post in ${langLabel} about: "${topic}". Tone: ${tone}. Add 3-5 relevant hashtags.`,
          email:     `Write a professional client email in ${langLabel} about: "${topic}". Tone: ${tone}. Include: Subject line (labeled "Subject:"), then a blank line, then the email body.`,
          bio:       `Write a professional bio in ${langLabel} about: "${topic}". Tone: ${tone}. 2-3 sentences, suitable for social media profile.`,
          headline:  `Generate 5 catchy headlines in ${langLabel} for: "${topic}". Tone: ${tone}. Number them 1-5.`,
          whatsapp:  `Write a WhatsApp message in ${langLabel} about: "${topic}". Tone: ${tone}. Keep it concise and conversational.`,
        };

        const prompt = typePrompts[contentType] || typePrompts.instagram;
        bot.sendMessage(chatId, `✍️ כותב תוכן...`, { parse_mode: 'HTML' });

        const contentRes = await gemini.chat.completions.create({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.8,
        });
        const generated = contentRes.choices[0]?.message?.content || 'לא הצלחתי ליצור תוכן.';

        const typeLabels = { instagram: '📸 Instagram', facebook: '📘 Facebook', email: '📧 מייל', bio: '👤 ביו', headline: '📰 כותרות', whatsapp: '💬 WhatsApp' };
        return `${typeLabels[contentType] || '✍️ תוכן'} — <b>${topic}</b>\n\n${generated}`;
      }

      // ── Code Generation (#31) ─────────────────────────────────────────────
      case 'generate_code': {
        const codeDesc   = args.description || '';
        const codeLang   = args.language || 'javascript';
        const asFile     = args.send_as_file === true;

        const codePrompt = `Write ${codeLang} code for: "${codeDesc}".
Provide:
1. A brief explanation (2-3 lines)
2. The complete, working code

Format the code inside a proper code block. Keep it clean and well-commented.`;

        bot.sendMessage(chatId, `💻 כותב קוד ${codeLang}...`);

        const codeRes = await gemini.chat.completions.create({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: codePrompt }],
          temperature: 0.3,
        });
        const codeOutput = codeRes.choices[0]?.message?.content || 'לא הצלחתי לייצר קוד.';

        if (asFile) {
          const extMap = { javascript: 'js', python: 'py', bash: 'sh', html: 'html', css: 'css', sql: 'sql' };
          const ext      = extMap[codeLang] || 'txt';
          const dateStr  = new Date().toISOString().slice(0,10);
          const tmpPath  = `/tmp/code-${dateStr}-${Date.now()}.${ext}`;
          // Extract just the code block if present
          const codeMatch = codeOutput.match(/```(?:\w+)?\n([\s\S]*?)```/);
          fs.writeFileSync(tmpPath, codeMatch ? codeMatch[1] : codeOutput, 'utf8');
          return `__FILE__:${tmpPath}`;
        }

        return `💻 <b>קוד ${codeLang}:</b> ${codeDesc}\n\n${codeOutput}`;
      }

      // ── Form Generator (#28) ──────────────────────────────────────────────
      case 'generate_form': {
        const formTitle  = args.title || 'טופס';
        const fields     = Array.isArray(args.fields) ? args.fields : [];
        const submitText = args.submit_text || 'שלח';
        const dateStr    = new Date().toISOString().slice(0,10);
        const tmpPath    = `/tmp/form-${dateStr}-${Date.now()}.html`;

        const fieldsHtml = fields.map(f => {
          const isEmail   = /email|אימייל|מייל/i.test(f);
          const isPhone   = /phone|טלפון|נייד/i.test(f);
          const isMessage = /message|הודעה|תוכן|פרטים/i.test(f);
          const inputType = isEmail ? 'email' : isPhone ? 'tel' : 'text';
          if (isMessage) {
            return `<div class="field"><label>${f}</label><textarea name="${f}" rows="4" placeholder="${f}..." required></textarea></div>`;
          }
          return `<div class="field"><label>${f}</label><input type="${inputType}" name="${f}" placeholder="${f}..." required /></div>`;
        }).join('\n      ');

        const formHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${formTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.10); padding: 40px; max-width: 500px; width: 100%; }
    h1 { color: #1a73e8; font-size: 1.6rem; margin-bottom: 8px; }
    .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 28px; }
    .field { margin-bottom: 20px; }
    label { display: block; font-weight: 600; color: #333; margin-bottom: 6px; font-size: 0.95rem; }
    input, textarea { width: 100%; border: 2px solid #e0e6ef; border-radius: 8px; padding: 10px 14px; font-size: 1rem; font-family: inherit; transition: border-color 0.2s; direction: rtl; }
    input:focus, textarea:focus { outline: none; border-color: #1a73e8; }
    textarea { resize: vertical; }
    button { width: 100%; background: #1a73e8; color: #fff; border: none; border-radius: 8px; padding: 14px; font-size: 1.1rem; font-weight: 700; cursor: pointer; transition: background 0.2s; margin-top: 8px; }
    button:hover { background: #1557b0; }
    .success { display: none; background: #e6f4ea; color: #2e7d32; border-radius: 8px; padding: 14px; text-align: center; font-weight: 600; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${formTitle}</h1>
    <p class="subtitle">אנא מלא את הפרטים הבאים</p>
    <form id="mainForm">
      ${fieldsHtml}
      <button type="submit">${submitText}</button>
    </form>
    <div class="success" id="successMsg">✅ הטופס נשלח בהצלחה! נחזור אליך בהקדם.</div>
  </div>
  <script>
    document.getElementById('mainForm').addEventListener('submit', function(e) {
      e.preventDefault();
      this.style.display = 'none';
      document.getElementById('successMsg').style.display = 'block';
    });
  </script>
</body>
</html>`;

        fs.writeFileSync(tmpPath, formHtml, 'utf8');
        return `__FILE__:${tmpPath}`;
      }

      // ── Presentation Generator (#29) ──────────────────────────────────────
      case 'generate_presentation': {
        const presTitle  = args.title || args.topic || 'מצגת';
        const presTopic  = args.topic || args.title || 'נושא כללי';
        const slidesN    = Number(args.slides_count) || 5;
        const presLang   = args.language || 'he';
        const dateStr    = new Date().toISOString().slice(0,10);
        const tmpPath    = `/tmp/presentation-${dateStr}-${Date.now()}.html`;

        bot.sendMessage(chatId, `🎨 יוצר מצגת ${slidesN} שקפים...`);

        const slidesPrompt = `Create content for a ${slidesN}-slide presentation about "${presTopic}" in ${presLang === 'he' ? 'Hebrew' : 'English'}.
For each slide return EXACTLY this format (no extra text):
SLIDE 1
Title: <slide title>
Bullets:
- <point 1>
- <point 2>
- <point 3>

Repeat for all ${slidesN} slides. Keep bullet points concise (max 8 words each).`;

        const slideRes = await gemini.chat.completions.create({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: slidesPrompt }],
          temperature: 0.6,
        });
        const slideContent = slideRes.choices[0]?.message?.content || '';

        // Parse slides
        const slideBlocks = slideContent.split(/SLIDE \d+/i).filter(s => s.trim());
        const slides = slideBlocks.map((block, i) => {
          const titleMatch   = block.match(/Title:\s*(.+)/i);
          const bulletsMatch = [...block.matchAll(/- (.+)/g)].map(m => m[1].trim());
          return {
            num:     i + 1,
            title:   titleMatch ? titleMatch[1].trim() : `שקף ${i+1}`,
            bullets: bulletsMatch.length ? bulletsMatch : ['נושא חשוב', 'פרט מרכזי', 'סיכום'],
          };
        });

        // Ensure we have at least slidesN slides
        while (slides.length < slidesN) {
          slides.push({ num: slides.length + 1, title: `שקף ${slides.length + 1}`, bullets: ['תוכן כאן'] });
        }

        const slidesHtml = slides.slice(0, slidesN).map((s, i) => `
    <div class="slide${i === 0 ? ' active' : ''}" data-index="${i}">
      <div class="slide-number">${s.num} / ${slidesN}</div>
      <h2>${s.title}</h2>
      <ul>
        ${s.bullets.map(b => `<li>${b}</li>`).join('\n        ')}
      </ul>
    </div>`).join('');

        const presHtml = `<!DOCTYPE html>
<html lang="${presLang}" dir="${presLang === 'he' ? 'rtl' : 'ltr'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${presTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #0f0f1a; color: #fff; height: 100vh; overflow: hidden; }
    .presentation { position: relative; width: 100vw; height: 100vh; }
    .slide { display: none; position: absolute; inset: 0; flex-direction: column; justify-content: center; align-items: ${presLang === 'he' ? 'flex-end' : 'flex-start'}; padding: 60px 80px; background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%); }
    .slide.active { display: flex; }
    .slide-number { position: absolute; top: 20px; ${presLang === 'he' ? 'left' : 'right'}: 30px; color: #888; font-size: 0.9rem; }
    h2 { font-size: 2.5rem; font-weight: 700; margin-bottom: 32px; color: #7eb8f7; text-shadow: 0 0 20px rgba(126,184,247,0.3); max-width: 80%; text-align: ${presLang === 'he' ? 'right' : 'left'}; }
    ul { list-style: none; max-width: 75%; }
    li { font-size: 1.3rem; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.08); color: #dde; display: flex; align-items: center; gap: 12px; }
    li::before { content: '▶'; color: #7eb8f7; font-size: 0.7rem; flex-shrink: 0; }
    .nav { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); display: flex; gap: 16px; z-index: 10; }
    .nav button { background: rgba(126,184,247,0.15); border: 1px solid rgba(126,184,247,0.4); color: #7eb8f7; padding: 10px 24px; border-radius: 30px; cursor: pointer; font-size: 1rem; transition: all 0.2s; }
    .nav button:hover { background: rgba(126,184,247,0.3); }
    .title-slide h2 { font-size: 3rem; }
    .progress { position: fixed; bottom: 0; left: 0; height: 3px; background: #7eb8f7; transition: width 0.3s; }
  </style>
</head>
<body>
  <div class="presentation">
    ${slidesHtml}
    <div class="nav">
      <button id="prev">&#8592; הקודם</button>
      <button id="next">הבא &#8594;</button>
    </div>
    <div class="progress" id="progress"></div>
  </div>
  <script>
    let current = 0;
    const slides = document.querySelectorAll('.slide');
    const total  = slides.length;
    function show(n) {
      slides[current].classList.remove('active');
      current = (n + total) % total;
      slides[current].classList.add('active');
      document.getElementById('progress').style.width = ((current + 1) / total * 100) + '%';
    }
    document.getElementById('next').onclick = () => show(current + 1);
    document.getElementById('prev').onclick = () => show(current - 1);
    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') show(current + 1);
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   show(current - 1);
    });
    show(0);
  </script>
</body>
</html>`;

        fs.writeFileSync(tmpPath, presHtml, 'utf8');
        return `__FILE__:${tmpPath}`;
      }

      // ── Landing Page Generator (#27) ──────────────────────────────────────
      case 'generate_landing_page': {
        const bizName   = args.business_name || 'העסק שלי';
        const bizDesc   = args.description   || '';
        const services  = Array.isArray(args.services) ? args.services : [];
        const ctaText   = args.cta_text     || 'צור קשר';
        const color     = args.color        || 'blue';
        const dateStr   = new Date().toISOString().slice(0,10);
        const tmpPath   = `/tmp/landing-${dateStr}-${Date.now()}.html`;

        bot.sendMessage(chatId, `🌐 בונה דף נחיתה ל-${bizName}...`);

        const copyPrompt = `Create Hebrew landing page copy for "${bizName}" — ${bizDesc}.
Return EXACTLY this format:
HERO_HEADLINE: <compelling 5-8 word headline>
HERO_SUBTITLE: <supporting subtitle, 1 sentence>
VALUE_1_TITLE: <benefit title>
VALUE_1_TEXT: <1 sentence description>
VALUE_2_TITLE: <benefit title>
VALUE_2_TEXT: <1 sentence description>
VALUE_3_TITLE: <benefit title>
VALUE_3_TEXT: <1 sentence description>
CTA_HEADLINE: <closing call to action headline>`;

        const copyRes = await gemini.chat.completions.create({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: copyPrompt }],
          temperature: 0.7,
        });
        const copyText = copyRes.choices[0]?.message?.content || '';

        function extractLine(key) {
          const m = copyText.match(new RegExp(`${key}:\\s*(.+)`));
          return m ? m[1].trim() : '';
        }
        const heroHeadline  = extractLine('HERO_HEADLINE')  || `ברוכים הבאים ל-${bizName}`;
        const heroSubtitle  = extractLine('HERO_SUBTITLE')  || bizDesc;
        const val1Title     = extractLine('VALUE_1_TITLE')  || 'מקצועיות';
        const val1Text      = extractLine('VALUE_1_TEXT')   || 'שירות מקצועי ואמין';
        const val2Title     = extractLine('VALUE_2_TITLE')  || 'ניסיון';
        const val2Text      = extractLine('VALUE_2_TEXT')   || 'שנים של ניסיון בתחום';
        const val3Title     = extractLine('VALUE_3_TITLE')  || 'תוצאות';
        const val3Text      = extractLine('VALUE_3_TEXT')   || 'תוצאות מוכחות ללקוחות';
        const ctaHeadline   = extractLine('CTA_HEADLINE')   || 'מוכנים להתחיל?';

        const colorMap = {
          blue:   { primary: '#1a73e8', dark: '#0d47a1', gradient: 'linear-gradient(135deg, #1a73e8, #0d47a1)' },
          green:  { primary: '#2e7d32', dark: '#1b5e20', gradient: 'linear-gradient(135deg, #43a047, #2e7d32)' },
          purple: { primary: '#6a1b9a', dark: '#4a148c', gradient: 'linear-gradient(135deg, #8e24aa, #6a1b9a)' },
          orange: { primary: '#e65100', dark: '#bf360c', gradient: 'linear-gradient(135deg, #f4511e, #e65100)' },
          dark:   { primary: '#212121', dark: '#000000', gradient: 'linear-gradient(135deg, #424242, #212121)' },
        };
        const c = colorMap[color] || colorMap.blue;

        const servicesSection = services.length > 0
          ? `<section class="services"><div class="container"><h2>השירותים שלנו</h2><div class="services-grid">${services.map(s => `<div class="service-card"><span class="icon">✓</span><span>${s}</span></div>`).join('')}</div></div></section>`
          : '';

        const landingHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bizName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #222; direction: rtl; }
    a { text-decoration: none; }
    /* Nav */
    nav { background: #fff; padding: 16px 40px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,0.08); position: sticky; top: 0; z-index: 100; }
    .logo { font-size: 1.4rem; font-weight: 700; color: ${c.primary}; }
    .nav-cta { background: ${c.primary}; color: #fff; padding: 10px 24px; border-radius: 25px; font-weight: 600; font-size: 0.95rem; transition: opacity 0.2s; }
    .nav-cta:hover { opacity: 0.85; }
    /* Hero */
    .hero { background: ${c.gradient}; color: #fff; padding: 100px 40px; text-align: center; }
    .hero h1 { font-size: 2.8rem; font-weight: 800; margin-bottom: 20px; line-height: 1.2; }
    .hero p { font-size: 1.2rem; opacity: 0.9; max-width: 600px; margin: 0 auto 36px; }
    .hero-btn { background: #fff; color: ${c.primary}; padding: 16px 40px; border-radius: 30px; font-size: 1.1rem; font-weight: 700; display: inline-block; transition: transform 0.2s; }
    .hero-btn:hover { transform: translateY(-2px); }
    /* Values */
    .values { padding: 80px 40px; background: #f8f9fa; }
    .container { max-width: 1100px; margin: 0 auto; }
    .values h2 { text-align: center; font-size: 2rem; color: ${c.primary}; margin-bottom: 48px; }
    .values-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 28px; }
    .value-card { background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 2px 16px rgba(0,0,0,0.07); border-top: 4px solid ${c.primary}; }
    .value-card h3 { color: ${c.primary}; font-size: 1.2rem; margin-bottom: 12px; }
    .value-card p { color: #555; line-height: 1.6; }
    /* Services */
    .services { padding: 60px 40px; background: #fff; }
    .services h2 { text-align: center; font-size: 2rem; color: ${c.primary}; margin-bottom: 36px; }
    .services-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .service-card { background: #f0f4ff; border-radius: 12px; padding: 20px 24px; display: flex; align-items: center; gap: 12px; font-size: 1rem; font-weight: 500; }
    .service-card .icon { color: ${c.primary}; font-size: 1.2rem; font-weight: 700; }
    /* CTA */
    .cta-section { background: ${c.gradient}; color: #fff; padding: 80px 40px; text-align: center; }
    .cta-section h2 { font-size: 2.2rem; margin-bottom: 16px; }
    .cta-section p { font-size: 1.1rem; opacity: 0.9; margin-bottom: 32px; }
    .cta-btn { background: #fff; color: ${c.primary}; padding: 16px 48px; border-radius: 30px; font-size: 1.1rem; font-weight: 700; display: inline-block; transition: transform 0.2s; }
    .cta-btn:hover { transform: translateY(-2px); }
    /* Contact */
    .contact { padding: 60px 40px; background: #f8f9fa; text-align: center; }
    .contact h2 { font-size: 1.8rem; color: ${c.primary}; margin-bottom: 24px; }
    .contact-form { max-width: 480px; margin: 0 auto; }
    .contact-form input, .contact-form textarea { width: 100%; border: 2px solid #e0e6ef; border-radius: 10px; padding: 12px 16px; font-size: 1rem; margin-bottom: 14px; font-family: inherit; direction: rtl; }
    .contact-form input:focus, .contact-form textarea:focus { outline: none; border-color: ${c.primary}; }
    .contact-form button { width: 100%; background: ${c.primary}; color: #fff; border: none; border-radius: 10px; padding: 14px; font-size: 1.05rem; font-weight: 700; cursor: pointer; }
    /* Footer */
    footer { background: #222; color: #aaa; text-align: center; padding: 24px; font-size: 0.9rem; }
    @media (max-width: 768px) { .hero h1 { font-size: 2rem; } nav { padding: 14px 20px; } .hero, .values, .services, .cta-section, .contact { padding: 60px 20px; } }
  </style>
</head>
<body>
  <nav>
    <span class="logo">${bizName}</span>
    <a href="#contact" class="nav-cta">${ctaText}</a>
  </nav>
  <section class="hero">
    <h1>${heroHeadline}</h1>
    <p>${heroSubtitle}</p>
    <a href="#contact" class="hero-btn">${ctaText} &rsaquo;</a>
  </section>
  <section class="values">
    <div class="container">
      <h2>למה לבחור בנו?</h2>
      <div class="values-grid">
        <div class="value-card"><h3>${val1Title}</h3><p>${val1Text}</p></div>
        <div class="value-card"><h3>${val2Title}</h3><p>${val2Text}</p></div>
        <div class="value-card"><h3>${val3Title}</h3><p>${val3Text}</p></div>
      </div>
    </div>
  </section>
  ${servicesSection}
  <section class="cta-section">
    <h2>${ctaHeadline}</h2>
    <p>${bizDesc || 'אנחנו כאן כדי לעזור לך להצליח'}</p>
    <a href="#contact" class="cta-btn">${ctaText}</a>
  </section>
  <section class="contact" id="contact">
    <h2>צור קשר</h2>
    <div class="contact-form">
      <input type="text" placeholder="שם מלא" />
      <input type="email" placeholder="אימייל" />
      <input type="tel" placeholder="טלפון" />
      <textarea rows="4" placeholder="איך נוכל לעזור?"></textarea>
      <button onclick="alert('תודה! נחזור אליך בהקדם 🙏')">${ctaText}</button>
    </div>
  </section>
  <footer>&copy; ${new Date().getFullYear()} ${bizName}. כל הזכויות שמורות.</footer>
</body>
</html>`;

        fs.writeFileSync(tmpPath, landingHtml, 'utf8');
        return `__FILE__:${tmpPath}`;
      }

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
    { role: 'system', content: buildSystemPrompt(memory, chatId) },
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
  saveRecentTopic(chatId, text); // context-aware: track what we discussed
  return reply;
}

module.exports = { handleMessage, _resetToolCalls, _getToolCalls };
