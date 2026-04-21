'use strict';

const cron    = require('node-cron');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { getMorningMedSummary } = require('./medications');
const { hadEntryYesterday, getYesterdayHealth } = require('./health');
const { getOpenTasks } = require('./tasks');
const { getDailyWord, formatWord } = require('./english'); // getDailyWord is async
const { buildSummaryMessage }      = require('./daily-summary');
const { buildWeeklySummaryMessage } = require('./weekly-summary');
const { sendNews }                 = require('./news');
const { getCalendarEvents }        = require('./google');
const { fetchAINews, buildNewsMessage } = require('../skills/news');
const { getTodayHabitSummary }     = require('./habits');

const QUOTES_PATH = path.join(__dirname, '..', 'data', 'quotes.json');

// ── Quotes ────────────────────────────────────────────────────────────────────
let quotes = [];
try {
  quotes = JSON.parse(fs.readFileSync(QUOTES_PATH, 'utf8'));
} catch {
  quotes = [{ text: 'כל יום הוא הזדמנות חדשה.', author: 'LifePilot', lang: 'he' }];
}

// Rotate quote index daily (based on day-of-year)
function getDailyQuote() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return quotes[dayOfYear % quotes.length];
}

// ── Hebrew date helpers ───────────────────────────────────────────────────────
function getHebrewDateLine() {
  const now = new Date();
  const dayName = now.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long' });
  const fullDate = now.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `${dayName}, ${fullDate}`;
}

// ── Weather via wttr.in (no API key) ─────────────────────────────────────────
function fetchWeather() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'wttr.in',
      path: '/Rishon+LeZion?format=j1&lang=he',
      method: 'GET',
      headers: { 'User-Agent': 'curl/7.0' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const current = j.current_condition[0];
          const desc    = current.lang_he?.[0]?.value || current.weatherDesc[0].value;
          const tempC   = current.temp_C;
          const feelsC  = current.FeelsLikeC;
          const humidity = current.humidity;
          resolve(`🌡️ ${tempC}°C (מרגיש ${feelsC}°C) | ${desc} | לחות ${humidity}%`);
        } catch {
          resolve('🌤️ מזג האוויר אינו זמין כרגע');
        }
      });
    });
    req.on('error', () => resolve('🌤️ מזג האוויר אינו זמין כרגע'));
    req.setTimeout(6000, () => { req.destroy(); resolve('🌤️ מזג האוויר אינו זמין כרגע'); });
    req.end();
  });
}

// ── Daily tips (rotated by day-of-week) ──────────────────────────────────────
const DAILY_TIPS = [
  '💡 <b>טיפ יום ראשון:</b> תכנן את השבוע — 3 מטרות עיקריות שתרצה להשיג.',
  '💡 <b>טיפ יום שני:</b> עבוד בבלוקים של 25 דקות. הפסקות קצרות משמרות אנרגיה.',
  '💡 <b>טיפ יום שלישי:</b> זמן טוב לבדוק GitHub commits ולעדכן README בפרויקטים.',
  '💡 <b>טיפ יום רביעי:</b> שתה מים, תמתח. CRPS מגיב טוב לתנועה עדינה.',
  '💡 <b>טיפ יום חמישי:</b> סקור את הפרויקטים הפעילים — מה קרוב לסיום?',
  '💡 <b>טיפ יום שישי:</b> נתק בשעה סבירה. מנוחה בסוף השבוע = ביצועים טובים יותר.',
  '💡 <b>טיפ שבת:</b> יום ללא מסכים אם אפשרי. מיינדפולנס ורגיעה.',
];

function getDailyTip() {
  const day = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long' });
  const dayIndex = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
    .findIndex((d) => day.includes(d));
  return DAILY_TIPS[dayIndex >= 0 ? dayIndex : 0];
}

// ── Build the morning message ─────────────────────────────────────────────────
async function buildMorningMessage() {
  const [weather, aiStories, quote, calendarToday] = await Promise.all([
    fetchWeather(),
    fetchAINews().catch(() => []),
    Promise.resolve(getDailyQuote()),
    getCalendarEvents(1).catch(() => null),
  ]);

  const dateStr = getHebrewDateLine();
  const tip     = getDailyTip();

  const lines = [
    `☀️ <b>בוקר טוב שילה!</b> — ${dateStr}`,
    '',
    `🌤️ <b>מזג אוויר ראשון לציון:</b>`,
    weather,
    '',
  ];

  // Tasks section
  const openTasks = await getOpenTasks();
  const taskCount = openTasks.length;
  if (taskCount === 0) {
    lines.push('📋 <b>משימות היום:</b> ✅ אין משימות פתוחות');
  } else {
    lines.push(`📋 <b>משימות היום:</b> ${taskCount} פתוחות`);
    openTasks.slice(0, 3).forEach((t) => lines.push(`• ${t.text}`));
  }
  lines.push('');

  // Medications section
  const medSummary = getMorningMedSummary();
  if (medSummary) {
    lines.push(medSummary);
    lines.push('');
  }

  // Yesterday health section
  const yHealth = await getYesterdayHealth();
  if (yHealth) {
    lines.push('💊 <b>בריאות אתמול:</b>');
    lines.push(
      `🩺 כאב: ${yHealth.painLevel}/10 | 😊 מצב רוח: ${yHealth.mood}/10 | 💤 שינה: ${yHealth.sleep}ש'` +
      (yHealth.symptoms ? `\n📝 ${yHealth.symptoms}` : '')
    );
    lines.push('');
  } else if (!(await hadEntryYesterday())) {
    lines.push('📝 <b>תזכורת:</b> לא מילאת דיווח בריאות אתמול. /health');
    lines.push('');
  }

  // Habits section
  try {
    const habitSummary = await getTodayHabitSummary();
    if (habitSummary && habitSummary.total > 0) {
      lines.push(`🏃 <b>הרגלים:</b> ${habitSummary.done}/${habitSummary.total} בוצעו`);
      if (habitSummary.pending.length > 0) {
        habitSummary.pending.slice(0, 3).forEach(h => lines.push(`• ${h.icon} ${h.name}`));
      }
      lines.push('');
    }
  } catch {}

  // Today's calendar events
  if (calendarToday && calendarToday !== 'אין אירועים בתקופה זו.') {
    lines.push('📅 <b>פגישות היום:</b>');
    lines.push(calendarToday);
    lines.push('');
  }

  // AI news — up to 2 headlines in morning briefing
  if (aiStories.length > 0) {
    lines.push('🤖 <b>AI חדשות:</b>');
    aiStories.slice(0, 2).forEach(s => {
      const src = s.source ? ` [${s.source}]` : '';
      lines.push(`• <a href="${s.url}">${s.title}</a>${src}`);
    });
    lines.push('');
  }

  // Quote + tip
  const quoteBlock = `❝ ${quote.text} ❞\n— ${quote.author}`;
  lines.push(`✨ <b>ציטוט היום:</b>\n${quoteBlock}`);
  lines.push('');
  lines.push(tip);
  lines.push('');
  lines.push('יום פרודוקטיבי! 💪');

  return lines.join('\n');
}

// ── Start scheduler ───────────────────────────────────────────────────────────
/**
 * @param {import('node-telegram-bot-api')} bot
 * @param {string} chatId
 */
function startScheduler(bot, chatId) {
  async function sendMorning() {
    try {
      const msg = await buildMorningMessage();
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      console.log('[Scheduler] Morning message sent');
    } catch (err) {
      console.error('[Scheduler] Morning message error:', err.message);
    }
  }

  // 07:00 Israel = 04:00 UTC
  cron.schedule('0 4 * * *', sendMorning, { timezone: 'UTC' });

  // Daily English word at 10:00 Israel = 07:00 UTC
  cron.schedule('0 7 * * *', sendEnglishWord, { timezone: 'UTC' });

  async function sendEnglishWord() {
    try {
      const word = await getDailyWord();
      await bot.sendMessage(chatId, formatWord(word, '📚 מילת האנגלית של היום'), { parse_mode: 'HTML' });
      console.log('[Scheduler] English word sent:', word.word);
    } catch (err) {
      console.error('[Scheduler] English word error:', err.message);
    }
  }

  async function sendWeeklySummary() {
    try {
      const msg = await buildWeeklySummaryMessage();
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      console.log('[Scheduler] Weekly summary sent');
    } catch (err) {
      console.error('[Scheduler] Weekly summary error:', err.message);
    }
  }

  // Weekly summary: Friday 14:00 IL = Friday 11:00 UTC
  cron.schedule('0 11 * * 5', sendWeeklySummary, { timezone: 'UTC' });

  async function sendDailyNews() {
    try {
      const msg = await buildNewsMessage('all', { ignoreDedup: false });
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
      console.log('[Scheduler] Daily news sent (4-category)');
    } catch (err) {
      console.error('[Scheduler] Daily news error:', err.message);
      // Fallback to legacy
      await sendNews(bot, chatId, false);
    }
  }

  async function sendDailySummary() {
    try {
      const msg = await buildSummaryMessage(0);
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      console.log('[Scheduler] Daily summary sent');
    } catch (err) {
      console.error('[Scheduler] Daily summary error:', err.message);
    }
  }

  // Tech news at 12:00 Israel = 09:00 UTC
  cron.schedule('0 9 * * *', sendDailyNews, { timezone: 'UTC' });

  // Daily summary at 22:00 Israel = 19:00 UTC
  cron.schedule('0 19 * * *', sendDailySummary, { timezone: 'UTC' });

  console.log('✅ [Scheduler] Morning 07:00 + English 10:00 + News 12:00 + Summary 22:00 + Weekly Fri 14:00 (IL) scheduled');

  return { sendMorning, sendEnglishWord, sendDailyNews, sendDailySummary, sendWeeklySummary };
}

module.exports = { startScheduler, buildMorningMessage };
