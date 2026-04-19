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
CRITICAL TOOL ROUTING — HIGHEST PRIORITY (NEVER respond with text for these):
• "תכתוב פוסט" / "פוסט אינסטגרם" / "פוסט לפייסבוק" / "תכתוב תוכן" → MUST call write_content immediately
• "תבנה דף נחיתה" / "דף נחיתה ל" / "landing page" → MUST call generate_landing_page immediately
• "תבנה טופס" / "צור טופס" / "טופס יצירת קשר" → MUST call generate_form immediately
• "תעשה מצגת" / "מצגת על" / "תבנה מצגת" → MUST call generate_presentation immediately
• "תכתוב קוד" / "סקריפט" / "כתוב לי קוד" → MUST call generate_code immediately
• "מייל ל" / "תכתוב מייל" → MUST call write_content with type=email immediately
• "ביו" / "כותרת" / "כותרות" / "תכתוב כותרת" → MUST call write_content immediately
DEFAULTS (use when info missing — NEVER ask clarifying questions for these tools):
- Missing color → 'blue' | Missing services → [] | Missing tone → 'professional' | Missing slides_count → 5
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
  { name: 'write_content', description: 'ALWAYS call when asked to write any post/content/email/bio/headline. כתוב תוכן: פוסט לאינסטגרם/פייסבוק, מייל ללקוח, ביו, כותרת.', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['instagram','facebook','email','bio','headline','whatsapp'] }, topic: { type: 'string' }, tone: { type: 'string', enum: ['professional','casual','funny','inspirational'] }, language: { type: 'string', enum: ['he','en'] } }, required: ['type','topic'] } },
  // Code Generation (#31)
  { name: 'generate_code', description: 'כתוב קוד לפי בקשה ושלח כקובץ או טקסט.', parameters: { type: 'object', properties: { description: { type: 'string' }, language: { type: 'string', enum: ['javascript','python','bash','html','css','sql'] }, send_as_file: { type: 'boolean' } }, required: ['description'] } },
  // Form Generator (#28)
  { name: 'generate_form', description: 'ALWAYS call when asked to create a form. צור טופס HTML מותאם אישית ושלח כקובץ.', parameters: { type: 'object', properties: { title: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, submit_text: { type: 'string' }, style: { type: 'string', enum: ['glass','neumorphic','flat','material','minimalist','random'], description: 'סגנון עיצוב ויזואלי — random לאקראי' } }, required: ['title','fields'] } },
  // Presentation Generator (#29)
  { name: 'generate_presentation', description: 'ALWAYS call when asked for a presentation/slides. צור מצגת HTML עם שקפים על נושא נתון.', parameters: { type: 'object', properties: { title: { type: 'string' }, topic: { type: 'string' }, slides_count: { type: 'number' }, language: { type: 'string', enum: ['he','en'] }, theme: { type: 'string', enum: ['dark-tech','light-minimal','gradient','corporate','creative','elegant','random'], description: 'ערכת נושא ויזואלית — random לאקראי' } }, required: ['title','topic'] } },
  // Lead Management (#42, #43, #44)
  { name: 'get_leads',      description: 'הצג רשימת לידים (הגשות טפסים) עם סטטוס.', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['all','new','closed','reminded'], description: 'ברירת מחדל: all' } }, required: [] } },
  { name: 'update_lead',    description: 'עדכן ליד: סטטוס, הערה. "סמן ישראל כנסגר" / "הוסף הערה לשילה".', parameters: { type: 'object', properties: { name_or_id: { type: 'string', description: 'שם או ID של הליד' }, status: { type: 'string', enum: ['new','contacted','closed','reminded'] }, notes: { type: 'string' } }, required: ['name_or_id'] } },
  { name: 'search_leads',   description: 'חפש לידים לפי שם, מייל, טלפון, או הערה.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'leads_summary',  description: 'סיכום סטטיסטי של לידים: כמה חדשים, נסגרו, השבוע, אחוז המרה.', parameters: { type: 'object', properties: {}, required: [] } },
  // Landing Page Generator (#27)
  { name: 'generate_landing_page', description: 'ALWAYS call when asked for a landing page. צור דף נחיתה HTML מקצועי לעסק או מוצר.', parameters: { type: 'object', properties: { business_name: { type: 'string' }, description: { type: 'string' }, services: { type: 'array', items: { type: 'string' } }, cta_text: { type: 'string' }, color: { type: 'string', enum: ['blue','green','purple','orange','dark'] }, template: { type: 'string', enum: ['minimal','bold','elegant','tech','corporate','random'], description: 'סגנון עיצוב — random לאקראי' } }, required: ['business_name'] } },
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
  // Leads (#42, #43, #44)
  'לידים', 'ליד', 'leads', 'lead', 'crm',
  'עדכן ליד', 'סמן ליד', 'הערה לליד', 'חפש ליד', 'סיכום לידים', 'סטטיסטיקות לידים',
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

        const contentStyles = [
          'use a personal anecdote or real moment',
          'start with a bold claim or surprising statistic',
          'open with a question that challenges assumptions',
          'use a contrarian or unexpected opinion',
          'tell a mini story in 3 sentences',
          'use an unexpected analogy or comparison',
        ];
        const styleHint = contentStyles[Math.floor(Math.random() * contentStyles.length)];

        const userContext = `You are writing social media content for Shilo Alkobi, founder of Digital Web.

FACTS about Shilo and Digital Web:
- Full name: Shilo Alkobi (שילה אלקובי)
- Location: Rishon LeZion, Israel
- Company: Digital Web — builds WordPress sites, React/Next.js apps, eCommerce, B2B solutions
- Also builds: CreatorShield (influencer protection platform), Vibe (AI app builder), personal AI bot
- Expertise: web dev, AI tools, SaaS, automation, WordPress security
- Audience: Israeli businesses and entrepreneurs
- Language: Hebrew (unless explicitly requested in English)

RULES:
- Write ONLY about the specific topic given — do NOT add generic industry content
- Write as Shilo in first person ("אני", "אצלנו", "בדיגיטל ווב")
- Make it personal, specific, and authentic — as if posted from his real account
- For Instagram: 150-200 words + emojis + 10-12 relevant hashtags including #digitalweb #שילהאלקובי
- Never start with generic openers like "בעולם הדיגיטלי של היום..."

CREATIVITY RULES:
- Never start with: 'בעידן הדיגיטלי', 'בעולם של היום', 'אנחנו חיים בעידן', 'בשנים האחרונות'
- Avoid clichés: 'פתרון מקיף', 'מקצועיות ללא פשרות', 'שירות איכותי', 'הצלחה מובטחת'
- Use specific numbers, real examples, surprising angles
- Pick ONE strong message, not 3 weak ones
- Each post must feel different from typical Israeli business content`;

        // Use system role for Gemini so context is always respected
        const systemMsg = { role: 'system', content: userContext };

        const toneMap = { professional: 'professional and authoritative', casual: 'friendly and conversational', funny: 'witty and humorous', inspirational: 'motivational and empowering' };
        const toneLabel = toneMap[tone] || tone;

        const typePrompts = {
          instagram: `Write a compelling Instagram post in ${langLabel} about: "${topic}".\nTone: ${toneLabel}.\nStructure:\n1. Hook sentence (grab attention immediately — mention the specific topic)\n2. Main message (2-4 lines with relevant emojis throughout)\n3. Call to action (1 line, first person)\n4. 10-12 relevant hashtags on a new line including #digitalweb #שילהאלקובי #פיתוחאתרים\n\nSTYLE FOR THIS POST: ${styleHint}`,
          facebook:  `Write an engaging Facebook post in ${langLabel} about: "${topic}".\nTone: ${toneLabel}.\nStructure:\n1. Opening hook (1-2 lines, specific to the topic)\n2. Story or value from Shilo's personal experience (3-5 lines)\n3. Question or CTA to encourage comments\n4. 3-5 hashtags\n\nSTYLE FOR THIS POST: ${styleHint}`,
          email:     `Write a professional client email in ${langLabel} about: "${topic}".\nTone: ${toneLabel}.\nFormat:\nSubject: <compelling subject line specific to "${topic}">\n\n<greeting>\n\n<opening paragraph — establish context related to "${topic}">\n\n<main body — 2-3 paragraphs with value, based on Shilo's expertise>\n\n<closing paragraph + clear next step>\n\n<signature: שילה אלקובי | Digital Web | digitalweb.co.il>`,
          bio:       `Write a professional social media bio in ${langLabel} about: "${topic}".\nTone: ${toneLabel}.\n2-3 punchy sentences. Specific to the topic. Include: who Shilo is, what he builds, what makes him unique. Add 3-5 relevant emojis.`,
          headline:  `Generate 5 unique, click-worthy headlines in ${langLabel} for: "${topic}".\nTone: ${toneLabel}.\nMust be specific to "${topic}" — not generic.\nVariety: one question, one bold claim, one how-to, one number-based, one emotional.\nNumber them 1-5.\n\nSTYLE DIRECTION: ${styleHint}`,
          whatsapp:  `Write a WhatsApp business message in ${langLabel} about: "${topic}".\nTone: ${toneLabel}.\nUnder 150 words. Conversational but professional. Specific to "${topic}". Relevant emoji. Clear CTA at end.\n\nSTYLE FOR THIS MESSAGE: ${styleHint}`,
        };

        const userPrompt = typePrompts[contentType] || typePrompts.instagram;
        bot.sendMessage(chatId, `✍️ כותב תוכן — ${contentType}...`);

        const creativeTemp = ['email'].includes(contentType) ? 0.7 : 0.95;
        const contentRes = await gemini.chat.completions.create({
          model: 'gemini-2.5-flash',
          messages: [systemMsg, { role: 'user', content: userPrompt }],
          temperature: creativeTemp,
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

        const codePrompt = `Write production-ready ${codeLang} code for: "${codeDesc}".

Structure your response EXACTLY as:

## הסבר
[2-3 lines in Hebrew explaining what the code does and why]

## קוד
\`\`\`${codeLang}
[complete working code — add Hebrew comments on key logic lines, include proper error handling, edge cases handled]
\`\`\`

## שימוש
[1-2 lines in Hebrew showing how to run or call this code]

## הערות
[Any important dependencies, limitations, or edge cases in Hebrew — skip if none]

Rules:
- Code must be complete and runnable, not pseudocode
- Add error handling (try/catch, input validation)
- Hebrew comments on non-obvious logic
- Include a basic usage example in the code itself`;

        bot.sendMessage(chatId, `💻 כותב קוד ${codeLang}...`);

        const codeRes = await gemini.chat.completions.create({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: codePrompt }],
          temperature: 0.2,
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
        const formsDir   = path.join(__dirname, '..', 'public', 'forms');
        fs.mkdirSync(formsDir, { recursive: true });
        const formId   = Date.now().toString(36);
        const formPath = path.join(formsDir, `${formId}.html`);

        // Detect form type and adapt design
        function detectFormStyle(title) {
          if (/רפואי|קליניקה|בריאות|רופא|מרפאה/i.test(title))
            return { bg: '#f0f9ff', accent: '#0ea5e9', accentDark: '#0284c7', cardBg: '#fff', icon: '🏥', subtitle: 'אנא מלא את הפרטים הרפואיים', successMsg: '✅ הפרטים התקבלו. הצוות הרפואי יחזור אליך בהקדם.' };
          if (/אירוע|הזמנה|חגיגה|מסיבה|כנס|וובינר/i.test(title))
            return { bg: '#fdf4ff', accent: '#a855f7', accentDark: '#7c3aed', cardBg: '#fff', icon: '🎉', subtitle: 'נשמח לראותך! מלא את הפרטים לרישום', successMsg: '🎉 נרשמת בהצלחה! נשלח לך אישור בקרוב.' };
          if (/עסקי|ליד|פגישה|הצעת מחיר|ייעוץ|עסק/i.test(title))
            return { bg: '#f0fdf4', accent: '#22c55e', accentDark: '#16a34a', cardBg: '#fff', icon: '💼', subtitle: 'נשמח לשמוע ממך ולהציע הצעה מותאמת', successMsg: '✅ קיבלנו את פרטיך. נחזור אליך תוך 24 שעות.' };
          if (/סקר|משוב|חוות דעת|דירוג/i.test(title))
            return { bg: '#fff7ed', accent: '#f97316', accentDark: '#ea580c', cardBg: '#fff', icon: '📊', subtitle: 'חוות דעתך חשובה לנו מאוד', successMsg: '🙏 תודה על המשוב! זה עוזר לנו להשתפר.' };
          return { bg: '#f0f4f8', accent: '#1a73e8', accentDark: '#1557b0', cardBg: '#fff', icon: '📋', subtitle: 'אנא מלא את הפרטים הבאים', successMsg: '✅ הטופס נשלח בהצלחה! נחזור אליך בהקדם.' };
        }
        const style = detectFormStyle(formTitle);

        // ── Form visual style selection ───────────────────────────────────────
        let formStyleName = args.style;
        if (!formStyleName || formStyleName === 'random') {
          const styleOpts = ['glass','neumorphic','flat','material','minimalist'];
          formStyleName = styleOpts[Math.floor(Math.random() * styleOpts.length)];
        }
        console.log(`[Form] Using style: ${formStyleName}`);

        const formVisualCss = {
          glass: `body{background:linear-gradient(135deg,#667eea,#764ba2)!important}
.container{background:rgba(255,255,255,0.15)!important;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.3)!important;box-shadow:0 8px 32px rgba(0,0,0,0.3)!important}
h1{color:#fff!important}
.subtitle{color:rgba(255,255,255,0.8)!important}
label{color:#fff!important}
.required{color:#ffe!important}
input,textarea{background:rgba(255,255,255,0.2)!important;border:1px solid rgba(255,255,255,0.4)!important;color:#fff!important}
input::placeholder,textarea::placeholder{color:rgba(255,255,255,0.55)!important}
input:focus,textarea:focus{background:rgba(255,255,255,0.3)!important;border-color:#fff!important;box-shadow:0 0 0 3px rgba(255,255,255,0.2)!important}`,
          neumorphic: `body{background:#e0e5ec!important}
.container{background:#e0e5ec!important;box-shadow:9px 9px 16px #a3b1c6,-9px -9px 16px #fff!important;border-radius:20px!important}
input,textarea{background:#e0e5ec!important;border:none!important;box-shadow:inset 4px 4px 8px #a3b1c6,inset -4px -4px 8px #fff!important;border-radius:10px!important}
input:focus,textarea:focus{box-shadow:inset 5px 5px 10px #a3b1c6,inset -5px -5px 10px #fff!important;outline:none!important;border:none!important}
button{box-shadow:4px 4px 8px #a3b1c6,-4px -4px 8px #fff!important}
button:hover{box-shadow:2px 2px 4px #a3b1c6,-2px -2px 4px #fff!important;transform:none!important}`,
          flat: `body{background:#3498db!important}
.container{background:#fff!important;border-radius:0!important;box-shadow:none!important;border-left:6px solid #2c3e50}
input,textarea{background:#ecf0f1!important;border:none!important;border-radius:0!important;border-bottom:2px solid #bdc3c7!important;box-shadow:none!important}
input:focus,textarea:focus{border-bottom-color:#3498db!important;background:#fff!important;box-shadow:none!important}
button{border-radius:0!important;letter-spacing:1px;text-transform:uppercase;font-size:0.9rem}`,
          material: `body{background:#f5f5f5!important}
.container{background:#fff!important;border-radius:2px!important;box-shadow:0 2px 4px rgba(0,0,0,0.12),0 8px 16px rgba(0,0,0,0.08)!important}
input,textarea{background:#fff!important;border:none!important;border-bottom:1px solid #bdbdbd!important;border-radius:0!important;padding-left:0!important;padding-right:0!important}
input:focus,textarea:focus{border-bottom:2px solid ${style.accent}!important;box-shadow:none!important;background:#fff!important}
button{border-radius:2px!important;letter-spacing:0.5px;text-transform:uppercase;font-size:0.85rem;box-shadow:0 2px 4px rgba(0,0,0,0.2)!important}
button:hover{box-shadow:0 4px 8px rgba(0,0,0,0.2)!important}`,
          minimalist: `body{background:#fff!important}
.container{background:#fff!important;box-shadow:none!important;border:1px solid #ebebeb!important;border-radius:8px!important}
input,textarea{background:#fafafa!important;border:1px solid #e0e0e0!important;border-radius:4px!important}
input:focus,textarea:focus{border-color:#111!important;box-shadow:none!important;background:#fff!important}
button{border-radius:4px!important;font-weight:700;letter-spacing:0.3px}`,
        }[formStyleName] || '';

        const fieldsHtml = fields.map(f => {
          const isEmail   = /email|אימייל|מייל/i.test(f);
          const isPhone   = /phone|טלפון|נייד/i.test(f);
          const isMessage = /message|הודעה|תוכן|פרטים|הערות/i.test(f);
          const isDate    = /תאריך|date/i.test(f);
          const isNumber  = /גיל|מספר|כמות/i.test(f);
          let inputType = isEmail ? 'email' : isPhone ? 'tel' : isDate ? 'date' : isNumber ? 'number' : 'text';
          if (isMessage) {
            return `<div class="field"><label>${f} <span class="required">*</span></label><textarea name="${f}" rows="4" placeholder="${f}..." required></textarea></div>`;
          }
          const validationAttr = isEmail ? 'pattern="[^@]+@[^@]+\\.[^@]+"' : isPhone ? 'pattern="[0-9+\\-\\s]{7,15}"' : '';
          return `<div class="field"><label>${f} <span class="required">*</span></label><input type="${inputType}" name="${f}" placeholder="${f}..." required ${validationAttr} /></div>`;
        }).join('\n      ');

        const formHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${formTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: ${style.bg}; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { background: ${style.cardBg}; border-radius: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.12); padding: 44px; max-width: 520px; width: 100%; }
    .form-header { text-align: center; margin-bottom: 32px; }
    .form-icon { font-size: 2.4rem; margin-bottom: 10px; }
    h1 { color: ${style.accent}; font-size: 1.7rem; margin-bottom: 8px; }
    .subtitle { color: #777; font-size: 0.92rem; }
    .field { margin-bottom: 20px; }
    label { display: block; font-weight: 600; color: #333; margin-bottom: 7px; font-size: 0.95rem; }
    .required { color: ${style.accent}; }
    input, textarea { width: 100%; border: 2px solid #e2e8f0; border-radius: 10px; padding: 11px 15px; font-size: 1rem; font-family: inherit; transition: border-color 0.2s, box-shadow 0.2s; direction: rtl; background: #fafafa; }
    input:focus, textarea:focus { outline: none; border-color: ${style.accent}; box-shadow: 0 0 0 3px ${style.accent}22; background: #fff; }
    input:invalid:not(:placeholder-shown) { border-color: #ef4444; }
    textarea { resize: vertical; min-height: 100px; }
    button { width: 100%; background: ${style.accent}; color: #fff; border: none; border-radius: 10px; padding: 14px; font-size: 1.1rem; font-weight: 700; cursor: pointer; transition: background 0.2s, transform 0.1s; margin-top: 10px; }
    button:hover { background: ${style.accentDark}; transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    .success { display: none; background: #f0fdf4; border: 2px solid #86efac; color: #166534; border-radius: 12px; padding: 20px; text-align: center; font-weight: 600; font-size: 1.05rem; margin-top: 16px; }
    .progress-bar { height: 4px; background: ${style.accent}; border-radius: 2px; width: 0%; transition: width 0.3s; margin-bottom: 28px; }
  </style>
  ${formVisualCss ? `<style>/* style: ${formStyleName} */\n${formVisualCss}\n  </style>` : ''}
</head>
<body>
  <div class="container">
    <div class="progress-bar" id="progressBar"></div>
    <div class="form-header">
      <div class="form-icon">${style.icon}</div>
      <h1>${formTitle}</h1>
      <p class="subtitle">${style.subtitle}</p>
    </div>
    <form id="mainForm" novalidate>
      ${fieldsHtml}
      <button type="submit">${submitText}</button>
    </form>
    <div class="success" id="successMsg">${style.successMsg}</div>
  </div>
  <script>
    const form = document.getElementById('mainForm');
    const inputs = form.querySelectorAll('input, textarea');
    // Live progress bar
    function updateProgress() {
      const filled = [...inputs].filter(i => i.value.trim()).length;
      document.getElementById('progressBar').style.width = (filled / inputs.length * 100) + '%';
    }
    inputs.forEach(i => i.addEventListener('input', updateProgress));
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      let valid = true;
      inputs.forEach(i => { if (!i.value.trim()) { i.style.borderColor = '#ef4444'; valid = false; } else { i.style.borderColor = ''; } });
      if (!valid) return;
      const data = {};
      inputs.forEach(i => { if (i.name) data[i.name] = i.value; });
      try {
        await fetch('https://lifepilot-bot.onrender.com/api/form-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '${formTitle}', data, chatId: '${chatId}' })
        });
      } catch(err) { /* silent fail — form still shows success */ }
      this.style.display = 'none';
      document.getElementById('successMsg').style.display = 'block';
    });
  </script>
</body>
</html>`;

        fs.writeFileSync(formPath, formHtml, 'utf8');
        const formUrl = `https://lifepilot-bot.onrender.com/forms/${formId}.html`;
        return `🔗 <b>הטופס מוכן!</b>\n<a href="${formUrl}">${formUrl}</a>\n\n<i>שתף את הקישור עם לקוחות — הגשות יגיעו ישירות לטלגרם שלך</i>`;
      }

      // ── Presentation Generator (#29) ──────────────────────────────────────
      case 'generate_presentation': {
        const presTitle  = args.title || args.topic || 'מצגת';
        const presTopic  = args.topic || args.title || 'נושא כללי';
        const requested      = Number(args.slides_count) || 5;
        const contentSlides  = requested <= 2 ? 1 : Math.max(1, requested - 2);
        const includeThankyou = requested > 2;
        const totalSlides    = contentSlides + 1 + (includeThankyou ? 1 : 0);
        const presLang      = args.language || 'he';
        const isRtl         = presLang === 'he';
        const dateStr       = new Date().toISOString().slice(0,10);
        const tmpPath       = `/tmp/presentation-${dateStr}-${Date.now()}.html`;

        bot.sendMessage(chatId, `🎨 יוצר מצגת ${totalSlides} שקפים על "${presTopic}"...`);

        const slidesPrompt = `Create content for ${contentSlides} content slides for a presentation about "${presTopic}" in ${isRtl ? 'Hebrew' : 'English'}.
Also provide a subtitle for the title slide.

Return EXACTLY this format (no extra text, no markdown):
SUBTITLE: <one engaging subtitle for the title slide>
SLIDE 1
Title: <slide title>
Bullets:
- <point 1>
- <point 2>
- <point 3>
Notes: <one sentence speaker note>

Repeat SLIDE N format for all ${contentSlides} slides. Keep bullet points under 10 words each.

CREATIVITY:
- Each slide title must be unique and specific — not generic like 'מבוא' or 'סקירה כללית'
- Use action verbs in titles (e.g. 'גלה', 'בנה', 'הבן', 'שנה')
- Bullet points start with action words or surprising facts
- Avoid repeating the same structure across slides`;

        const slideRes = await gemini.chat.completions.create({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: slidesPrompt }],
          temperature: 0.85,
        });
        const slideContent = slideRes.choices[0]?.message?.content || '';

        // Extract subtitle
        const subtitleMatch = slideContent.match(/SUBTITLE:\s*(.+)/i);
        const presSubtitle  = subtitleMatch ? subtitleMatch[1].trim() : presTopic;

        // Parse content slides
        const slideBlocks = slideContent.split(/SLIDE \d+/i).filter(s => s.trim());
        const contentSlideData = slideBlocks.map((block, i) => {
          const titleMatch   = block.match(/Title:\s*(.+)/i);
          const bulletsMatch = [...block.matchAll(/^- (.+)/gm)].map(m => m[1].trim());
          const notesMatch   = block.match(/Notes:\s*(.+)/i);
          return {
            title:   titleMatch ? titleMatch[1].trim() : `שקף ${i+1}`,
            bullets: bulletsMatch.length ? bulletsMatch : ['נושא חשוב', 'פרט מרכזי'],
            notes:   notesMatch ? notesMatch[1].trim() : '',
          };
        });
        while (contentSlideData.length < contentSlides) {
          contentSlideData.push({ title: `שקף ${contentSlideData.length+1}`, bullets: ['תוכן כאן'], notes: '' });
        }

        // Build all slides: title + content + optional thank-you
        const allSlides = [
          { type: 'title', title: presTitle, subtitle: presSubtitle, notes: '' },
          ...contentSlideData.slice(0, contentSlides).map(s => ({ type: 'content', ...s })),
          ...(includeThankyou ? [{ type: 'thankyou', title: isRtl ? 'תודה רבה!' : 'Thank You!', subtitle: isRtl ? 'שאלות ותגובות' : 'Questions & Discussion', notes: '' }] : []),
        ];

        // ── Presentation theme selection ──────────────────────────────────────
        let presThemeName = args.theme;
        if (!presThemeName || presThemeName === 'random') {
          const themeOpts = ['dark-tech','light-minimal','gradient','corporate','creative','elegant'];
          presThemeName = themeOpts[Math.floor(Math.random() * themeOpts.length)];
        }
        console.log(`[Presentation] Using theme: ${presThemeName}`);

        const presThemeCss = {
          'dark-tech': '', // default — existing dark theme
          'light-minimal': `body{background:#fff!important;color:#111}
.slide{background:#fff!important;color:#111}
.title-slide,.thankyou-slide{background:#f4f6f8!important}
.title-slide h1,.thankyou-slide h1{color:#111!important;text-shadow:none!important}
.title-sub{color:#555!important}
.slide-label{color:#999!important}
h2{color:#111!important;text-shadow:none!important}
li{color:#333!important;border-bottom-color:rgba(0,0,0,0.07)!important}
li::before{color:#666!important}
.slide-number{color:#bbb!important}
.nav button{background:rgba(0,0,0,0.05)!important;border-color:rgba(0,0,0,0.15)!important;color:#333!important}
.progress{background:linear-gradient(90deg,#333,#777)!important}`,
          gradient: `.slide:nth-child(1){background:linear-gradient(135deg,#667eea,#764ba2)!important}
.slide:nth-child(2){background:linear-gradient(135deg,#f093fb,#f5576c)!important}
.slide:nth-child(3){background:linear-gradient(135deg,#4facfe,#00f2fe)!important}
.slide:nth-child(4){background:linear-gradient(135deg,#43e97b,#38f9d7)!important}
.slide:nth-child(5){background:linear-gradient(135deg,#fa709a,#fee140)!important}
.slide:nth-child(6){background:linear-gradient(135deg,#a18cd1,#fbc2eb)!important}
.slide:nth-child(7){background:linear-gradient(135deg,#fccb90,#d57eeb)!important}
.slide:nth-child(8){background:linear-gradient(135deg,#96fbc4,#f9f586)!important;color:#333!important}
.title-slide,.thankyou-slide{background:linear-gradient(135deg,#667eea,#764ba2)!important}
h2{text-shadow:0 2px 8px rgba(0,0,0,0.2)!important}
li{border-bottom-color:rgba(255,255,255,0.15)!important}
.progress{background:linear-gradient(90deg,#f093fb,#f5576c,#667eea)!important}`,
          corporate: `body{background:#003366!important}
.slide{background:linear-gradient(180deg,#003d80 0%,#003366 100%)!important}
.title-slide,.thankyou-slide{background:linear-gradient(135deg,#001f4d,#003366)!important}
.title-slide h1,.thankyou-slide h1{color:#7eb8f7!important;text-shadow:none!important}
.title-sub{color:rgba(126,184,247,0.75)!important}
.slide-label{color:rgba(126,184,247,0.6)!important}
h2{color:#7eb8f7!important;text-shadow:none!important;font-size:2.1rem!important}
li{color:#d0e8fa!important;border-bottom-color:rgba(126,184,247,0.12)!important}
li::before{content:'■'!important;font-size:0.45rem!important;color:#7eb8f7!important}
.slide-number{color:rgba(126,184,247,0.5)!important}
.nav button{background:rgba(126,184,247,0.08)!important;border-color:rgba(126,184,247,0.2)!important;color:#7eb8f7!important}
.progress{background:linear-gradient(90deg,#7eb8f7,#4a9fd4)!important}`,
          creative: `body{background:#12001e!important}
.slide{background:linear-gradient(135deg,#1a0030,#0f0a2e)!important}
.title-slide,.thankyou-slide{background:linear-gradient(135deg,#e94560,#1a0030)!important}
.title-slide h1,.thankyou-slide h1{color:#fff!important;text-shadow:0 0 30px rgba(233,69,96,0.6)!important}
.title-sub{color:rgba(255,255,255,0.7)!important}
.slide-label{color:rgba(233,69,96,0.8)!important}
h2{color:#e94560!important;font-size:2.5rem!important;text-shadow:0 0 20px rgba(233,69,96,0.3)!important}
li{color:#e8e0ff!important;border-bottom-color:rgba(233,69,96,0.12)!important}
li::before{content:'◆'!important;color:#e94560!important;font-size:0.45rem!important}
.slide-number{color:rgba(233,69,96,0.5)!important}
.nav button{background:rgba(233,69,96,0.12)!important;border-color:rgba(233,69,96,0.35)!important;color:#e94560!important}
.progress{background:linear-gradient(90deg,#e94560,#f5a623)!important}`,
          elegant: `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap');
body{background:#f5f0e8!important;color:#2c1810}
.slide{background:linear-gradient(160deg,#faf6ef,#f0e8d8)!important;color:#2c1810!important}
.title-slide,.thankyou-slide{background:linear-gradient(135deg,#2c1810,#4a2e22)!important}
.title-slide h1,.thankyou-slide h1{color:#d4a853!important;text-shadow:none!important;font-family:'Cormorant Garamond',Georgia,serif!important;font-weight:600}
.title-sub{color:rgba(212,168,83,0.75)!important}
.slide-label{color:#a08060!important}
h2{color:#2c1810!important;text-shadow:none!important;font-family:'Cormorant Garamond',Georgia,serif!important;font-size:2.9rem!important;font-weight:600}
li{color:#4a3728!important;border-bottom-color:rgba(44,24,16,0.1)!important}
li::before{content:'—'!important;color:#d4a853!important;font-size:0.9rem!important;font-weight:normal}
.slide-number{color:#a08060!important}
.nav button{background:rgba(44,24,16,0.05)!important;border-color:rgba(44,24,16,0.2)!important;color:#2c1810!important}
.progress{background:linear-gradient(90deg,#d4a853,#8b6f47)!important}`,
        }[presThemeName] || '';

        const buildSlideHtml = (s, idx, total) => {
          const isActive = idx === 0 ? ' active' : '';
          if (s.type === 'title') {
            return `<div class="slide title-slide${isActive}" data-index="${idx}">
      <div class="slide-label">${isRtl ? presTitle : presTitle}</div>
      <h1>${s.title}</h1>
      <p class="title-sub">${s.subtitle}</p>
      <div class="slide-number">${idx+1} / ${total}</div>
      <div class="speaker-notes">${s.notes}</div>
    </div>`;
          }
          if (s.type === 'thankyou') {
            return `<div class="slide thankyou-slide${isActive}" data-index="${idx}">
      <h1>${s.title}</h1>
      <p class="title-sub">${s.subtitle}</p>
      <div class="slide-number">${idx+1} / ${total}</div>
      <div class="speaker-notes"></div>
    </div>`;
          }
          return `<div class="slide${isActive}" data-index="${idx}">
      <div class="slide-number">${idx+1} / ${total}</div>
      <h2>${s.title}</h2>
      <ul>
        ${s.bullets.map(b => `<li>${b}</li>`).join('\n        ')}
      </ul>
      <div class="speaker-notes">${s.notes}</div>
    </div>`;
        };

        const slidesHtml = allSlides.map((s, i) => buildSlideHtml(s, i, allSlides.length)).join('\n    ');

        const presHtml = `<!DOCTYPE html>
<html lang="${presLang}" dir="${isRtl ? 'rtl' : 'ltr'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${presTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #0a0a18; color: #fff; height: 100vh; overflow: hidden; }
    .presentation { position: relative; width: 100vw; height: 100vh; }
    /* Mobile optimization */
    @media (max-width: 768px) {
      .slide { padding: 40px 24px !important; }
      .title-slide h1, .thankyou-slide h1 { font-size: 2.2rem !important; }
      h2 { font-size: 1.6rem !important; max-width: 100% !important; margin-bottom: 24px !important; }
      li { font-size: 1rem !important; }
      .nav { bottom: 16px !important; gap: 8px !important; left: 50% !important; transform: translateX(-50%) !important; }
      .nav button { padding: 10px 16px !important; font-size: 0.85rem !important; min-width: 70px !important; }
      .slide-number { top: 12px !important; left: 16px !important; font-size: 0.75rem !important; }
      .title-sub { font-size: 1rem !important; }
      .slide-label { font-size: 0.75rem !important; }
    }
    /* Touch hint */
    .touch-hint { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.8); color: #fff; padding: 16px 24px; border-radius: 12px; font-size: 0.9rem; z-index: 100; pointer-events: none; animation: fadeOut 3s forwards; }
    @media (max-width: 768px) { .touch-hint { display: block; } }
    @keyframes fadeOut { 0%, 70% { opacity: 1; } 100% { opacity: 0; display: none; } }
    @keyframes slideIn { from { opacity: 0; transform: translateX(${isRtl ? '-' : ''}20px); } to { opacity: 1; transform: translateX(0); } }
    .slide { display: none; position: absolute; inset: 0; flex-direction: column; justify-content: center; align-items: ${isRtl ? 'flex-end' : 'flex-start'}; padding: 60px 80px; background: linear-gradient(140deg, #0a0a18 0%, #131328 50%, #0d1b35 100%); }
    .slide.active { display: flex; animation: slideIn 0.35s ease; }
    .slide-number { position: absolute; top: 22px; ${isRtl ? 'left' : 'right'}: 32px; color: #556; font-size: 0.85rem; letter-spacing: 1px; }
    /* Title + Thank-you slides */
    .title-slide, .thankyou-slide { justify-content: center; align-items: center; text-align: center; background: linear-gradient(140deg, #0d1b35 0%, #1a1a40 60%, #0a0a18 100%); }
    .title-slide h1, .thankyou-slide h1 { font-size: 3.4rem; font-weight: 800; color: #7eb8f7; text-shadow: 0 0 40px rgba(126,184,247,0.4); margin-bottom: 18px; }
    .title-sub { font-size: 1.3rem; color: #99b; opacity: 0.85; margin-top: 8px; }
    .slide-label { font-size: 0.85rem; letter-spacing: 3px; text-transform: uppercase; color: #7eb8f7; opacity: 0.7; margin-bottom: 20px; }
    /* Content slides */
    h2 { font-size: 2.4rem; font-weight: 700; margin-bottom: 36px; color: #7eb8f7; text-shadow: 0 0 20px rgba(126,184,247,0.25); max-width: 82%; text-align: ${isRtl ? 'right' : 'left'}; }
    ul { list-style: none; max-width: 76%; }
    li { font-size: 1.25rem; padding: 11px 0; border-bottom: 1px solid rgba(255,255,255,0.07); color: #ccd; display: flex; align-items: center; gap: 14px; }
    li::before { content: '▶'; color: #7eb8f7; font-size: 0.65rem; flex-shrink: 0; }
    /* Speaker notes (hidden visually, toggle with N key) */
    .speaker-notes { display: none; position: absolute; bottom: 70px; ${isRtl ? 'right' : 'left'}: 80px; font-size: 0.85rem; color: #778; font-style: italic; max-width: 60%; }
    .notes-visible .speaker-notes { display: block; }
    /* Nav */
    .nav { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; gap: 14px; z-index: 10; }
    .nav button { background: rgba(126,184,247,0.12); border: 1px solid rgba(126,184,247,0.35); color: #7eb8f7; padding: 9px 22px; border-radius: 28px; cursor: pointer; font-size: 0.95rem; transition: all 0.2s; }
    .nav button:hover { background: rgba(126,184,247,0.28); }
    /* Progress bar */
    .progress { position: fixed; bottom: 0; left: 0; height: 3px; background: linear-gradient(90deg, #7eb8f7, #a78bfa); transition: width 0.35s ease; }
  </style>
  ${presThemeCss ? `<style>/* theme: ${presThemeName} */\n${presThemeCss}\n  </style>` : ''}
</head>
<body>
  <div class="presentation" id="pres">
    ${slidesHtml}
    <div class="nav">
      <button id="prev">&#8592; ${isRtl ? 'הקודם' : 'Prev'}</button>
      <button id="next">${isRtl ? 'הבא' : 'Next'} &#8594;</button>
    </div>
    <div class="progress" id="progress"></div>
  </div>
  <div class="touch-hint">👆 הקש או החלק להעברת שקפים</div>
  <script>
    let cur = 0;
    const slides = document.querySelectorAll('.slide');
    const total  = slides.length;

    function show(n) {
      slides[cur].classList.remove('active');
      cur = (n + total) % total;
      slides[cur].classList.add('active');
      document.getElementById('progress').style.width = ((cur + 1) / total * 100) + '%';
    }

    // Button clicks
    document.getElementById('next').onclick = () => show(cur + 1);
    document.getElementById('prev').onclick = () => show(cur - 1);

    // Keyboard (desktop)
    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') show(cur + 1);
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')  show(cur - 1);
      if (e.key === 'n' || e.key === 'N') document.getElementById('pres').classList.toggle('notes-visible');
    });

    // Mobile: swipe + tap
    let touchStartX = 0;
    let touchEndX   = 0;
    const pres = document.getElementById('pres');

    pres.addEventListener('touchstart', e => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    pres.addEventListener('touchend', e => {
      touchEndX = e.changedTouches[0].screenX;
      const diff = touchEndX - touchStartX;
      if (Math.abs(diff) < 50) {
        // Tap — advance forward
        show(cur + 1);
        return;
      }
      // RTL: swipe LEFT = next, swipe RIGHT = prev
      if (diff < 0) show(cur + 1);
      else          show(cur - 1);
    }, { passive: true });

    show(0);
  </script>
</body>
</html>`;

        fs.writeFileSync(tmpPath, presHtml, 'utf8');
        return `__FILE__:${tmpPath}`;
      }

      // ── Lead Management (#42, #43) ────────────────────────────────────────
      case 'get_leads': {
        const { loadLeads } = require('./leads');
        const filterStatus = args.status || 'all';
        const allLeads = loadLeads();
        const filtered = (filterStatus === 'all' ? allLeads : allLeads.filter(l => l.status === filterStatus))
          .slice(-20).reverse(); // newest first
        if (!filtered.length) return `📋 אין לידים${filterStatus !== 'all' ? ` בסטטוס "${filterStatus}"` : ''}.`;
        const statusEmoji = { new: '🆕', closed: '✅', reminded: '⏰' };
        const lines = filtered.map(l => {
          const name  = l.data?.['שם'] || l.data?.name || '—';
          const email = l.data?.['אימייל'] || l.data?.email || '';
          const phone = l.data?.['טלפון'] || l.data?.phone || '';
          const date  = new Date(l.createdAt).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
          const contact = [email, phone].filter(Boolean).join(' | ');
          return `${statusEmoji[l.status] || '•'} <b>${name}</b> — ${l.title}\n   ${contact ? contact + ' | ' : ''}${date}`;
        });
        const total = allLeads.length;
        const newCount = allLeads.filter(l => l.status === 'new').length;
        return `📋 <b>לידים</b> (${total} סה"כ, ${newCount} 🆕)\n\n` + lines.join('\n\n');
      }

      case 'update_lead': {
        const { updateLead } = require('./leads');
        const result = updateLead(args.name_or_id, { status: args.status, notes: args.notes });
        if (!result) return `❌ לא נמצא ליד עבור "${args.name_or_id}"`;
        const name = result.data?.['שם'] || result.data?.name || result.id;
        let msg = `✅ <b>${name}</b> עודכן\n`;
        if (args.status) msg += `סטטוס: ${args.status}\n`;
        if (args.notes)  msg += `הערה: ${args.notes}\n`;
        return msg;
      }

      case 'search_leads': {
        const { searchLeads } = require('./leads');
        const results = searchLeads(args.query || '');
        if (!results.length) return `🔍 לא נמצאו לידים עבור "${args.query}"`;
        const statusEmoji = { new: '🆕', closed: '✅', reminded: '⏰', contacted: '📞' };
        return `🔍 <b>תוצאות: ${results.length}</b>\n\n` + results.map(l => {
          const name  = l.data?.['שם'] || l.data?.name || '—';
          const email = l.data?.['אימייל'] || l.data?.email || '';
          const phone = l.data?.['טלפון'] || l.data?.phone || '';
          const notes = l.notes ? `\n   📝 ${l.notes}` : '';
          const date  = new Date(l.createdAt).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
          return `${statusEmoji[l.status] || '•'} <b>${name}</b> (${date})\n   ${[email, phone].filter(Boolean).join(' | ')}${notes}`;
        }).join('\n\n');
      }

      case 'leads_summary': {
        const { getLeadsSummary } = require('./leads');
        const s = getLeadsSummary();
        return `📊 <b>סיכום לידים</b>\n\n` +
          `סה"כ: ${s.total}\n` +
          `🆕 חדשים: ${s.new}\n` +
          `📞 טופלו/נסגרו: ${s.closed}\n` +
          `⏰ הופנו: ${s.reminded}\n` +
          `📅 השבוע: ${s.thisWeek}\n` +
          `📈 אחוז המרה: ${s.convRate}%`;
      }

      // ── Landing Page Generator (#27) ──────────────────────────────────────
      case 'generate_landing_page': {
        const bizName   = args.business_name || 'העסק שלי';
        const bizDesc   = args.description   || '';
        const services  = Array.isArray(args.services) ? args.services : [];
        const ctaText   = args.cta_text     || 'צור קשר';
        const color     = args.color        || 'blue';
        const formsDir2  = path.join(__dirname, '..', 'public', 'forms');
        fs.mkdirSync(formsDir2, { recursive: true });
        const landingId   = Date.now().toString(36);
        const landingPath = path.join(formsDir2, `landing-${landingId}.html`);

        bot.sendMessage(chatId, `🌐 בונה דף נחיתה ל-${bizName}...`);

        const heroStyles = [
          'punchy and direct — short powerful sentence',
          'emotional and inspiring — connect to a dream or fear',
          'data-driven — lead with a specific number or stat',
          'question-based — challenge an assumption',
          'metaphor or comparison — unexpected analogy',
        ];
        const heroStyle = heroStyles[Math.floor(Math.random() * heroStyles.length)];

        const copyPrompt = `Create professional Hebrew landing page copy for "${bizName}" — ${bizDesc}.
Return EXACTLY this format (no extra text):
HERO_HEADLINE: <compelling 5-8 word Hebrew headline>
HERO_SUBTITLE: <supporting subtitle, 1 sentence>
VALUE_1_TITLE: <benefit title>
VALUE_1_TEXT: <1 sentence description>
VALUE_2_TITLE: <benefit title>
VALUE_2_TEXT: <1 sentence description>
VALUE_3_TITLE: <benefit title>
VALUE_3_TEXT: <1 sentence description>
CTA_HEADLINE: <closing call to action headline>
TEST_1_NAME: <realistic Israeli first+last name>
TEST_1_ROLE: <job title, company>
TEST_1_QUOTE: <realistic 1-2 sentence testimonial about ${bizName}>
TEST_2_NAME: <realistic Israeli first+last name>
TEST_2_ROLE: <job title, company>
TEST_2_QUOTE: <realistic 1-2 sentence testimonial about ${bizName}>
TEST_3_NAME: <realistic Israeli first+last name>
TEST_3_ROLE: <job title, company>
TEST_3_QUOTE: <realistic 1-2 sentence testimonial about ${bizName}>
FAQ_1_Q: <common question about ${bizName}>
FAQ_1_A: <clear answer, 1-2 sentences>
FAQ_2_Q: <common question about ${bizName}>
FAQ_2_A: <clear answer, 1-2 sentences>
FAQ_3_Q: <common question about ${bizName}>
FAQ_3_A: <clear answer, 1-2 sentences>

CREATIVITY RULES:
- Hero headline must NOT start with 'ברוכים הבאים' or contain 'מובילה' / 'מקצועית' / 'איכותית'
- Use specific numbers where possible: '150 אתרים בנינו השנה' not 'ניסיון רב'
- Each VALUE title must be UNIQUE — not generic like 'מקצועיות' / 'אמינות' / 'ניסיון'
- Testimonials must sound like REAL Israelis: use natural speech, specific company names, exact problems solved
HERO STYLE: ${heroStyle}`;

        const copyRes = await gemini.chat.completions.create({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: copyPrompt }],
          temperature: 0.9,
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
        // Testimonials
        const t1Name  = extractLine('TEST_1_NAME')  || 'דנה לוי';
        const t1Role  = extractLine('TEST_1_ROLE')  || 'מנכ"לית, חברת ABC';
        const t1Quote = extractLine('TEST_1_QUOTE') || `${bizName} שינו לנו את כל התמונה. תוצאות מדהימות!`;
        const t2Name  = extractLine('TEST_2_NAME')  || 'אמיר כהן';
        const t2Role  = extractLine('TEST_2_ROLE')  || 'יזם, סטארטאפ XYZ';
        const t2Quote = extractLine('TEST_2_QUOTE') || 'שירות מקצועי ומהיר. ממליץ בחום לכל עסק.';
        const t3Name  = extractLine('TEST_3_NAME')  || 'מיכל ברק';
        const t3Role  = extractLine('TEST_3_ROLE')  || 'בעלת עסק, Studio M';
        const t3Quote = extractLine('TEST_3_QUOTE') || 'עובדים איתם כבר שנתיים. פשוט מצוינים בכל מה שעושים.';
        // FAQ
        const faq1Q   = extractLine('FAQ_1_Q') || `מה כולל השירות של ${bizName}?`;
        const faq1A   = extractLine('FAQ_1_A') || 'השירות כולל ייעוץ מקצועי, ליווי מלא ותמיכה לאורך כל הדרך.';
        const faq2Q   = extractLine('FAQ_2_Q') || 'כמה זמן לוקח להתחיל?';
        const faq2A   = extractLine('FAQ_2_A') || 'אנחנו מתחילים בתוך 48 שעות ממועד אישור ההזמנה.';
        const faq3Q   = extractLine('FAQ_3_Q') || 'האם יש אחריות?';
        const faq3A   = extractLine('FAQ_3_A') || 'בהחלט — אנו עומדים מאחורי כל עבודה עם אחריות מלאה.';

        const colorMap = {
          blue:   { primary: '#1a73e8', dark: '#0d47a1', light: '#e8f0fe', gradient: 'linear-gradient(135deg, #1a73e8, #0d47a1)' },
          green:  { primary: '#16a34a', dark: '#15803d', light: '#f0fdf4', gradient: 'linear-gradient(135deg, #22c55e, #16a34a)' },
          purple: { primary: '#7c3aed', dark: '#6d28d9', light: '#f5f3ff', gradient: 'linear-gradient(135deg, #8b5cf6, #7c3aed)' },
          orange: { primary: '#ea580c', dark: '#c2410c', light: '#fff7ed', gradient: 'linear-gradient(135deg, #f97316, #ea580c)' },
          dark:   { primary: '#374151', dark: '#1f2937', light: '#f9fafb', gradient: 'linear-gradient(135deg, #4b5563, #1f2937)' },
        };
        const c = colorMap[color] || colorMap.blue;

        // ── Landing page template selection ──────────────────────────────────
        let lpTemplateName = args.template;
        if (!lpTemplateName || lpTemplateName === 'random') {
          const tplOpts = ['minimal','bold','elegant','tech','corporate'];
          lpTemplateName = tplOpts[Math.floor(Math.random() * tplOpts.length)];
        }
        console.log(`[LandingPage] Using template: ${lpTemplateName}`);

        const landingTplCss = {
          minimal: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
body{font-family:'Inter',sans-serif!important;background:#fff;color:#111}
.hero{background:#fff!important;color:#111;padding:160px 40px}
.hero h1{font-size:4rem;color:#000;text-shadow:none}
.hero p{color:#555}
.hero-btn{background:#000!important;color:#fff!important;border-radius:2px!important}
nav{background:#fff;box-shadow:0 1px 0 #eee}
.logo{color:#000!important}
.nav-cta{background:#000!important;border-radius:2px!important}
section h2{color:#000!important}
.values{background:#f9f9f9}
.value-card{border-top:2px solid #000!important;border-radius:0!important;box-shadow:none!important}
.value-card h3{color:#000!important}
.testimonials{background:#fff}
.testimonial-card{border-radius:0!important;box-shadow:none!important;border:1px solid #eee}
.testimonial-card::before{color:#000!important}
.cta-section{background:#111!important}
footer{background:#111}`,
          bold: `@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;700;900&display=swap');
body{font-family:'Poppins',sans-serif!important}
.hero{padding:120px 40px}
.hero h1{font-size:5rem;font-weight:900}
.value-card{background:${c.primary}!important;color:#fff;border-radius:24px!important;border:none!important;box-shadow:0 8px 32px rgba(0,0,0,0.15)!important}
.value-card h3{color:#fff!important}
.value-card p{color:rgba(255,255,255,0.85)!important}`,
          elegant: `@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap');
body{font-family:'Playfair Display',Georgia,serif!important;background:#faf7f2;color:#2c1810}
.hero{background:#faf7f2!important;color:#2c1810;padding:140px 40px}
.hero h1{font-size:3.5rem;color:#2c1810;text-shadow:none}
.hero p{color:#6b4c3b}
.hero-btn{background:#8b6f47!important;color:#fff!important;border-radius:4px!important}
nav{background:#faf7f2;box-shadow:0 1px 0 #e8ddd0}
.logo{color:#8b6f47!important}
.nav-cta{background:#8b6f47!important}
section h2{color:#8b6f47!important}
.values{background:#faf7f2}
.value-card{background:#fff;border-top:none!important;border-bottom:2px solid #8b6f47!important;border-radius:0!important;box-shadow:none!important}
.value-card h3{color:#8b6f47!important}
.testimonials{background:#fff}
.testimonial-card{background:#faf7f2!important;border-radius:4px!important;box-shadow:none!important;border:1px solid #e8ddd0}
.testimonial-card::before{color:#8b6f47!important}
.cta-section{background:#2c1810!important}
footer{background:#2c1810}`,
          tech: `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;800&display=swap');
body{font-family:'Space Grotesk',sans-serif!important;background:#0a0e27;color:#e0e8ff}
.hero{background:linear-gradient(135deg,#0a0e27 0%,#1a0a3e 100%)!important;color:#e0e8ff;padding:120px 40px}
.hero h1{font-size:4.5rem;color:#00ffd1;text-shadow:0 0 40px rgba(0,255,209,0.4)}
.hero p{color:rgba(0,255,209,0.85)}
.hero-btn{background:#00ffd1!important;color:#0a0e27!important}
nav{background:#0a0e27;box-shadow:0 1px 0 rgba(0,255,209,0.2)}
.logo{color:#00ffd1!important}
.nav-cta{background:#00ffd1!important;color:#0a0e27!important}
section h2{color:#00ffd1!important}
.values{background:#0d112b}
.value-card{background:rgba(0,255,209,0.05)!important;border:1px solid rgba(0,255,209,0.3)!important;border-top:none!important;border-radius:12px!important;box-shadow:none!important;color:#e0e8ff}
.value-card h3{color:#00ffd1!important}
.value-card p{color:#99c!important}
.testimonials{background:#0a0e27}
.testimonial-card{background:rgba(255,255,255,0.03)!important;border:1px solid rgba(0,255,209,0.2)!important;box-shadow:none!important;border-radius:12px!important}
.testimonial-card::before{color:#00ffd1!important}
.testimonial-quote{color:#aac!important}
.author-name{color:#e0e8ff!important}
.faq{background:#0d112b}
.faq-item{border-color:rgba(0,255,209,0.2)!important}
.faq-q{color:#e0e8ff!important}
.faq-q:hover{background:rgba(0,255,209,0.05)!important}
.faq-q .arrow{color:#00ffd1!important}
.faq-a{color:#aac!important}
.cta-section{background:linear-gradient(135deg,#00ffd1,#00b4d8)!important}
.cta-section h2{color:#0a0e27!important}
.cta-section p{color:rgba(0,0,0,0.7)!important;opacity:1!important}
.cta-btn{background:#0a0e27!important;color:#00ffd1!important}
.contact{background:#0a0e27}
.contact h2{color:#00ffd1!important}
.contact-form input,.contact-form textarea{border-color:#00ffd133!important;background:#0d112b!important;color:#e0e8ff}
.contact-form input:focus,.contact-form textarea:focus{border-color:#00ffd1!important}
.contact-form button{background:#00ffd1!important;color:#0a0e27!important}
.service-card{background:rgba(0,255,209,0.05)!important;border-color:rgba(0,255,209,0.3)!important;color:#e0e8ff}
.service-card .icon{color:#00ffd1!important}
footer{background:#060918}`,
          corporate: `@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
body{font-family:'Roboto',Arial,sans-serif!important}
.hero{background:linear-gradient(135deg,#003366 0%,#004d99 100%)!important;padding:100px 40px}
.hero h1{font-size:3rem}
.hero-btn{background:#fff!important;color:#003366!important;border-radius:4px!important}
nav{box-shadow:0 2px 8px rgba(0,0,0,0.08)}
.logo{color:#003366!important}
.nav-cta{background:#003366!important;border-radius:4px!important}
section h2{color:#003366!important}
.values{background:#f5f7fa}
.value-card{border-top:4px solid #003366!important;border-radius:4px!important}
.value-card h3{color:#003366!important}
.testimonials{background:#eef2f7}
.testimonial-card{border-radius:4px!important}
.testimonial-card::before{color:#003366!important}
.cta-section{background:#003366!important}
footer{background:#001a33}`,
        }[lpTemplateName] || '';

        const servicesSection = services.length > 0
          ? `<section class="services"><div class="container"><h2>השירותים שלנו</h2><div class="services-grid">${services.map(s => `<div class="service-card"><span class="icon">✓</span><span>${s}</span></div>`).join('')}</div></div></section>`
          : '';

        const landingHtml = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bizName} — ${heroSubtitle}</title>
  <meta name="description" content="${heroSubtitle}">
  <meta name="keywords" content="${bizName}, ${services.slice(0,3).join(', ')}">
  <meta property="og:title" content="${bizName}">
  <meta property="og:description" content="${heroSubtitle}">
  <meta property="og:type" content="website">
  <!-- Google Analytics placeholder -->
  <!-- <script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script> -->
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
    .hero { background: ${c.gradient}; color: #fff; padding: 110px 40px; text-align: center; }
    .hero h1 { font-size: 3rem; font-weight: 800; margin-bottom: 20px; line-height: 1.2; }
    .hero p { font-size: 1.2rem; opacity: 0.9; max-width: 620px; margin: 0 auto 38px; }
    .hero-btn { background: #fff; color: ${c.primary}; padding: 16px 44px; border-radius: 32px; font-size: 1.1rem; font-weight: 700; display: inline-block; transition: transform 0.2s, box-shadow 0.2s; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
    .hero-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(0,0,0,0.2); }
    /* Container */
    .container { max-width: 1100px; margin: 0 auto; }
    section h2 { text-align: center; font-size: 2rem; color: ${c.primary}; margin-bottom: 44px; }
    /* Values */
    .values { padding: 80px 40px; background: #f8f9fa; }
    .values-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 28px; }
    .value-card { background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 2px 16px rgba(0,0,0,0.06); border-top: 4px solid ${c.primary}; }
    .value-card h3 { color: ${c.primary}; font-size: 1.2rem; margin-bottom: 12px; }
    .value-card p { color: #555; line-height: 1.65; }
    /* Services */
    .services { padding: 64px 40px; background: #fff; }
    .services-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .service-card { background: ${c.light}; border-radius: 12px; padding: 20px 24px; display: flex; align-items: center; gap: 12px; font-size: 1rem; font-weight: 500; border: 1px solid ${c.primary}22; }
    .service-card .icon { color: ${c.primary}; font-size: 1.1rem; font-weight: 800; }
    /* Testimonials */
    .testimonials { padding: 80px 40px; background: ${c.light}; }
    .testimonials-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }
    .testimonial-card { background: #fff; border-radius: 16px; padding: 28px 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); position: relative; }
    .testimonial-card::before { content: '"'; font-size: 4rem; color: ${c.primary}; opacity: 0.15; position: absolute; top: 10px; right: 24px; line-height: 1; font-family: Georgia, serif; }
    .testimonial-quote { color: #444; line-height: 1.7; margin-bottom: 20px; font-style: italic; }
    .testimonial-author { display: flex; align-items: center; gap: 12px; }
    .author-avatar { width: 42px; height: 42px; border-radius: 50%; background: ${c.gradient}; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 1rem; flex-shrink: 0; }
    .author-name { font-weight: 700; color: #222; font-size: 0.95rem; }
    .author-role { color: #888; font-size: 0.82rem; }
    /* FAQ */
    .faq { padding: 80px 40px; background: #fff; }
    .faq-list { max-width: 800px; margin: 0 auto; }
    .faq-item { border: 1px solid #e5e7eb; border-radius: 12px; margin-bottom: 14px; overflow: hidden; }
    .faq-q { padding: 18px 24px; font-weight: 600; cursor: pointer; display: flex; justify-content: space-between; align-items: center; color: #222; transition: background 0.2s; }
    .faq-q:hover { background: ${c.light}; }
    .faq-q .arrow { color: ${c.primary}; font-size: 1.1rem; transition: transform 0.2s; }
    .faq-a { padding: 0 24px 18px; color: #555; line-height: 1.7; display: none; }
    .faq-item.open .faq-a { display: block; }
    .faq-item.open .arrow { transform: rotate(180deg); }
    /* CTA */
    .cta-section { background: ${c.gradient}; color: #fff; padding: 80px 40px; text-align: center; }
    .cta-section h2 { font-size: 2.2rem; margin-bottom: 16px; color: #fff; }
    .cta-section p { font-size: 1.1rem; opacity: 0.9; margin-bottom: 32px; }
    .cta-btn { background: #fff; color: ${c.primary}; padding: 16px 48px; border-radius: 32px; font-size: 1.1rem; font-weight: 700; display: inline-block; transition: transform 0.2s; }
    .cta-btn:hover { transform: translateY(-2px); }
    /* Contact */
    .contact { padding: 64px 40px; background: #f8f9fa; text-align: center; }
    .contact h2 { color: ${c.primary}; margin-bottom: 28px; }
    .contact-form { max-width: 480px; margin: 0 auto; }
    .contact-form input, .contact-form textarea { width: 100%; border: 2px solid #e0e6ef; border-radius: 10px; padding: 12px 16px; font-size: 1rem; margin-bottom: 14px; font-family: inherit; direction: rtl; transition: border-color 0.2s; }
    .contact-form input:focus, .contact-form textarea:focus { outline: none; border-color: ${c.primary}; }
    .contact-form button { width: 100%; background: ${c.primary}; color: #fff; border: none; border-radius: 10px; padding: 14px; font-size: 1.05rem; font-weight: 700; cursor: pointer; transition: background 0.2s; }
    .contact-form button:hover { background: ${c.dark}; }
    /* WhatsApp floating button */
    .whatsapp-btn { position: fixed; bottom: 28px; left: 28px; width: 58px; height: 58px; background: #25d366; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 20px rgba(37,211,102,0.4); font-size: 1.6rem; z-index: 999; transition: transform 0.2s; text-decoration: none; }
    .whatsapp-btn:hover { transform: scale(1.1); }
    /* Footer */
    footer { background: #1f2937; color: #9ca3af; text-align: center; padding: 24px; font-size: 0.9rem; }
    @media (max-width: 768px) { .hero h1 { font-size: 2.1rem; } nav { padding: 14px 20px; } .hero, .values, .testimonials, .faq, .cta-section, .contact { padding: 56px 20px; } }
  </style>
  ${landingTplCss ? `<style>/* template: ${lpTemplateName} */\n${landingTplCss}\n  </style>` : ''}
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

  <section class="testimonials">
    <div class="container">
      <h2>מה הלקוחות אומרים</h2>
      <div class="testimonials-grid">
        <div class="testimonial-card">
          <p class="testimonial-quote">${t1Quote}</p>
          <div class="testimonial-author">
            <div class="author-avatar">${t1Name.charAt(0)}</div>
            <div><div class="author-name">${t1Name}</div><div class="author-role">${t1Role}</div></div>
          </div>
        </div>
        <div class="testimonial-card">
          <p class="testimonial-quote">${t2Quote}</p>
          <div class="testimonial-author">
            <div class="author-avatar">${t2Name.charAt(0)}</div>
            <div><div class="author-name">${t2Name}</div><div class="author-role">${t2Role}</div></div>
          </div>
        </div>
        <div class="testimonial-card">
          <p class="testimonial-quote">${t3Quote}</p>
          <div class="testimonial-author">
            <div class="author-avatar">${t3Name.charAt(0)}</div>
            <div><div class="author-name">${t3Name}</div><div class="author-role">${t3Role}</div></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="faq">
    <div class="container">
      <h2>שאלות נפוצות</h2>
      <div class="faq-list">
        <div class="faq-item"><div class="faq-q">${faq1Q}<span class="arrow">▼</span></div><div class="faq-a">${faq1A}</div></div>
        <div class="faq-item"><div class="faq-q">${faq2Q}<span class="arrow">▼</span></div><div class="faq-a">${faq2A}</div></div>
        <div class="faq-item"><div class="faq-q">${faq3Q}<span class="arrow">▼</span></div><div class="faq-a">${faq3A}</div></div>
      </div>
    </div>
  </section>

  <section class="cta-section">
    <h2>${ctaHeadline}</h2>
    <p>${bizDesc || 'אנחנו כאן כדי לעזור לך להצליח'}</p>
    <a href="#contact" class="cta-btn">${ctaText}</a>
  </section>

  <section class="contact" id="contact">
    <h2>צור קשר</h2>
    <div class="contact-form">
      <input type="text" placeholder="שם מלא" required />
      <input type="email" placeholder="אימייל" required />
      <input type="tel" placeholder="טלפון" />
      <textarea rows="4" placeholder="איך נוכל לעזור?"></textarea>
      <button id="contactBtn">${ctaText}</button>
    </div>
  </section>

  <footer>&copy; ${new Date().getFullYear()} ${bizName}. כל הזכויות שמורות.</footer>

  <!-- WhatsApp floating button -->
  <a href="https://wa.me/972500000000" class="whatsapp-btn" target="_blank" title="WhatsApp">💬</a>

  <script>
    // FAQ accordion
    document.querySelectorAll('.faq-q').forEach(q => {
      q.addEventListener('click', () => {
        const item = q.parentElement;
        const wasOpen = item.classList.contains('open');
        document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
        if (!wasOpen) item.classList.add('open');
      });
    });
    // Contact form submission → Telegram
    document.getElementById('contactBtn').addEventListener('click', async function() {
      const inputs = document.querySelectorAll('.contact-form input, .contact-form textarea');
      const data = {};
      inputs.forEach(i => { if (i.value.trim()) data[i.placeholder] = i.value; });
      this.textContent = '⏳ שולח...';
      this.disabled = true;
      try {
        await fetch('https://lifepilot-bot.onrender.com/api/form-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'יצירת קשר — ${bizName}', data, chatId: '${chatId}' })
        });
      } catch(e) {}
      this.textContent = '✅ נשלח! נחזור אליך בהקדם 🙏';
    });
  </script>
</body>
</html>`;

        fs.writeFileSync(landingPath, landingHtml, 'utf8');
        const landingUrl = `https://lifepilot-bot.onrender.com/forms/landing-${landingId}.html`;
        return `🌐 <b>דף הנחיתה מוכן!</b>\n<a href="${landingUrl}">${landingUrl}</a>\n\n<i>הגשות טופס יצירת קשר יגיעו ישירות לטלגרם שלך</i>`;
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
