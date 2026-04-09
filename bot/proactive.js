'use strict';

const cron = require('node-cron');
const { getShabbatTimes, setShabbatWindow } = require('./shabbat');
const { getOpenTasks }  = require('./tasks');
const { getTodayHealth, getWeekRawStats } = require('./health');

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

  // ── SUNDAY 08:30 IL — Weekly planning ──────────────────────────────────────
  // Cron runs at 05:30 UTC = 08:30 IL
  cron.schedule('30 5 * * 0', async () => {
    try {
      // Date label (DD/MM/YYYY in IL timezone)
      const ilDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      const [yr, mo, dy] = ilDate.split('-');
      const dateStr = `${dy}/${mo}/${yr}`;

      // Tasks
      const openTasks = getOpenTasks() || [];
      const taskCount = openTasks.length;

      // Health raw stats (no LLM)
      const stats = getWeekRawStats(7);

      // Rule-based insight (no LLM)
      let insight = 'המשך כך! שמור על שגרת הטיפול השבועית.';
      if (stats) {
        if (stats.avgPain != null && stats.avgPain >= 7) {
          insight = 'שים לב לרמת הכאב הגבוהה — נסה להקפיד על מנוחה מספקת.';
        } else if (stats.avgSleep != null && stats.avgSleep < 6) {
          insight = 'שינה לא מספקת — נסה ללכת לישון קצת יותר מוקדם השבוע.';
        } else if (stats.avgMood != null && stats.avgMood < 5) {
          insight = 'מצב הרוח לא גבוה — אולי כדאי לתכנן פעילות מהנה השבוע.';
        } else if (stats.avgPain != null && stats.avgMood != null && stats.avgPain <= 4 && stats.avgMood >= 7) {
          insight = 'שבוע נהדר! הכאב בשליטה ומצב הרוח גבוה — כדאי לנצל את האנרגיה.';
        }
      }

      // Build message
      const lines = [`📅 תוכנית שבוע — ${dateStr}`, ''];

      if (taskCount === 0) {
        lines.push('✅ כל המשימות הושלמו!');
      } else {
        lines.push(`📋 משימות פתוחות: ${taskCount}`);
        openTasks.slice(0, 3).forEach((t) => lines.push(`• ${t.text}`));
      }

      if (stats) {
        lines.push('', '💊 בריאות שבוע שעבר:');
        if (stats.avgPain  != null) lines.push(`- כאב ממוצע: ${stats.avgPain.toFixed(1)}/10`);
        if (stats.avgSleep != null) lines.push(`- שינה ממוצעת: ${stats.avgSleep.toFixed(1)} שעות`);
        if (stats.avgMood  != null) lines.push(`- מצב רוח: ${stats.avgMood.toFixed(1)}/10`);
      }

      lines.push('', `💡 ${insight}`, '', 'שבוע טוב שילה! 💪');

      await bot.sendMessage(chatId, lines.join('\n'));
    } catch (e) {
      console.error('[Proactive] weekly error:', e.message);
      try { await bot.sendMessage(chatId, '📅 בוקר טוב שילה! שבוע טוב! 💪'); } catch {}
    }
  }, { timezone: 'Asia/Jerusalem' });

  console.log('[Proactive] Scheduler started — 3 jobs (Shabbat eve, health reminder, weekly plan) + Shabbat mode active');
}

module.exports = { startProactiveScheduler, isPikudAlert };
