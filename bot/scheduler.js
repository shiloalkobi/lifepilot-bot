'use strict';

const cron    = require('node-cron');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { getMorningMedSummary } = require('./medications');
const { hadEntryYesterday } = require('./health');

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
  const [weather, quote] = await Promise.all([fetchWeather(), getDailyQuote()]);
  const dateStr = getHebrewDateLine();
  const tip     = getDailyTip();

  const quoteBlock = quote.lang === 'he'
    ? `❝ ${quote.text} ❞\n— ${quote.author}`
    : `❝ ${quote.text} ❞\n— ${quote.author}`;

  const medSummary      = getMorningMedSummary();
  const missedYesterday = !hadEntryYesterday();

  return (
    `🌅 <b>בוקר טוב, שילה!</b>\n` +
    `📅 ${dateStr}\n\n` +
    `🏙️ <b>ראשון לציון:</b> ${weather}\n\n` +
    (medSummary ? `${medSummary}\n\n` : '') +
    (missedYesterday ? `📝 <b>תזכורת:</b> לא מילאת דיווח בריאות אתמול. /health\n\n` : '') +
    `✨ <b>ציטוט היום:</b>\n${quoteBlock}\n\n` +
    `${tip}`
  );
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

  // Every day at 07:00 Israel time (UTC+3 → cron runs in server UTC, so 04:00 UTC)
  // node-cron uses server local time; Render UTC → 04:00 UTC = 07:00 Asia/Jerusalem
  cron.schedule('0 4 * * *', sendMorning, { timezone: 'UTC' });

  console.log('✅ [Scheduler] Morning briefing scheduled — 07:00 Asia/Jerusalem daily');

  return { sendMorning };
}

module.exports = { startScheduler, buildMorningMessage };
