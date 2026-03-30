'use strict';

const cron = require('node-cron');
const { getShabbatTimes, setShabbatWindow } = require('./shabbat');
const { getOpenTasks }  = require('./tasks');
const { getTodayHealth } = require('./health');

// Pikud HaOref alert keywords — these always bypass Shabbat mode
const PIKUD_KEYWORDS = ['פיקוד העורף', 'אזעקה', 'ירי', 'רקטות', 'alert'];

function isPikudAlert(text) {
  return PIKUD_KEYWORDS.some(k => text.includes(k));
}

function startProactiveScheduler(bot, chatId) {

  // ── FRIDAY 16:30 IL — Shabbat eve briefing ─────────────────────────────────
  // Cron runs at 13:30 UTC = 16:30 IL (before candles)
  cron.schedule('30 13 * * 5', async () => {
    try {
      const times = await getShabbatTimes();

      // Set precise Shabbat window for this week
      if (times.candleTime && times.havdalahTime) {
        setShabbatWindow(times.candleTime, times.havdalahTime);
      }

      const candleStr = times.candleTime
        ? times.candleTime.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })
        : 'בדוק בלוח';

      const havdalahStr = times.havdalahTime
        ? times.havdalahTime.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })
        : '';

      // Get open tasks count
      const openTasks = getOpenTasks() || [];
      const taskLine  = openTasks.length > 0
        ? `📋 ${openTasks.length} משימות פתוחות השבוע`
        : '✅ כל המשימות הושלמו השבוע!';

      const parashaLine = times.parashaName
        ? `📖 פרשת השבוע: ${times.parashaName}`
        : '';

      const msg = [
        '🕯️ שבת שלום שילה!',
        '',
        `⏰ כניסת שבת: ${candleStr}`,
        havdalahStr ? `✨ צאת שבת: ${havdalahStr}` : '',
        '',
        parashaLine,
        '',
        taskLine,
        '',
        'שבת שלום ומבורכת 🌟',
      ].filter(Boolean).join('\n');

      await bot.sendMessage(chatId, msg);
    } catch (e) {
      console.error('[Proactive] friday error:', e.message);
      await bot.sendMessage(chatId, '🕯️ שבת שלום שילה! שבת שלום ומבורכת.');
    }
  }, { timezone: 'Asia/Jerusalem' });

  // ── DAILY 08:00 IL — Morning check-in ──────────────────────────────────────
  cron.schedule('0 8 * * *', async () => {
    try {
      const openTasks = getOpenTasks() || [];
      const count = openTasks.length;
      await bot.sendMessage(chatId,
        `בוקר טוב שילה ☀️ יש לך ${count} משימות פתוחות היום. רוצה לעבור עליהן?`
      );
    } catch (e) { console.error('[Proactive] morning error:', e.message); }
  }, { timezone: 'Asia/Jerusalem' });

  // ── DAILY 21:00 IL — Health reminder if not logged ─────────────────────────
  cron.schedule('0 21 * * *', async () => {
    try {
      const health = getTodayHealth();
      if (health) return; // already logged today
      await bot.sendMessage(chatId,
        'היי שילה 🌙 עוד לא תיעדת את הבריאות שלך היום.\nאיך אתה מרגיש? (כאב / מצב רוח / שינה)'
      );
    } catch (e) { console.error('[Proactive] health error:', e.message); }
  }, { timezone: 'Asia/Jerusalem' });

  console.log('[Proactive] Scheduler started — 3 jobs + Shabbat mode active');
}

module.exports = { startProactiveScheduler, isPikudAlert };
