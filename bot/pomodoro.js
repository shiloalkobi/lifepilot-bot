'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_FILE    = path.join(__dirname, '..', 'data', 'pomodoro.json');
const WORK_MIN     = 25;
const SHORT_BREAK  = 5;
const LONG_BREAK   = 15;
const CYCLES_UNTIL_LONG = 4;

// ── Stats storage ─────────────────────────────────────────────────────────────

function loadStats() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function saveStats(stats) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(stats, null, 2), 'utf8');
}

function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function getTodayStats() {
  const today = todayIL();
  return loadStats().find((s) => s.date === today) || { date: today, sessions: 0, totalMinutes: 0, cycleCount: 0 };
}

function recordSession(minutes) {
  const today  = todayIL();
  const stats  = loadStats();
  let entry    = stats.find((s) => s.date === today);
  if (!entry) { entry = { date: today, sessions: 0, totalMinutes: 0, cycleCount: 0 }; stats.push(entry); }
  entry.sessions++;
  entry.totalMinutes += minutes;
  entry.cycleCount    = (entry.cycleCount || 0) + 1;
  if (stats.length > 90) stats.shift();
  saveStats(stats);
  return entry;
}

// ── In-memory active sessions ─────────────────────────────────────────────────
// Map<chatId, { phase: 'work'|'break', minutes, startTime, timer, cycleNum }>
const sessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function remaining(session) {
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const total   = session.minutes * 60;
  return Math.max(0, total - elapsed);
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Core: start a session ─────────────────────────────────────────────────────

function startSession(bot, chatId, minutes, cycleNum, phase) {
  const isWork   = phase === 'work';
  const emoji    = isWork ? '🍅' : (minutes >= LONG_BREAK ? '🎉' : '☕');
  const label    = isWork ? 'עבודה' : 'הפסקה';

  const session = { phase, minutes, startTime: Date.now(), cycleNum, timer: null };
  sessions.set(String(chatId), session);

  bot.sendMessage(chatId,
    `${emoji} <b>סשן ${label} התחיל — ${minutes} דקות</b>\n` +
    (isWork ? `🔁 מחזור מס' ${cycleNum}` : `😴 נוח קצת!`),
    { parse_mode: 'HTML' }
  ).catch(() => {});

  session.timer = setTimeout(() => {
    sessions.delete(String(chatId));

    if (isWork) {
      const stats   = recordSession(minutes);
      const isLong  = stats.cycleCount % CYCLES_UNTIL_LONG === 0;
      const breakMin = isLong ? LONG_BREAK : SHORT_BREAK;

      if (isLong) {
        bot.sendMessage(chatId,
          `🎉 <b>סיימת ${CYCLES_UNTIL_LONG} סשנים!</b> כל הכבוד שילה!\n\n` +
          `☕ הפסקה ארוכה של <b>${LONG_BREAK} דקות</b> מתחילה עכשיו.\n\n` +
          `<i>שלח /pomo כשמוכן/ה להמשיך</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      } else {
        bot.sendMessage(chatId,
          `🍅 <b>סיום סשן!</b> עבדת ${minutes} דקות מעולה.\n\n` +
          `☕ הפסקה קצרה של <b>${SHORT_BREAK} דקות</b> מתחילה עכשיו.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }

      // Auto-start break
      startSession(bot, chatId, breakMin, cycleNum, 'break');
    } else {
      // Break ended
      bot.sendMessage(chatId,
        `⏰ <b>ההפסקה נגמרה!</b>\n\nמוכן/ה לסשן הבא? /pomo`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }, minutes * 60 * 1000);
}

// ── Public API ────────────────────────────────────────────────────────────────

function startPomo(bot, chatId, customMinutes) {
  const key = String(chatId);

  if (sessions.has(key)) {
    const s    = sessions.get(key);
    const rem  = remaining(s);
    const label = s.phase === 'work' ? '🍅 עבודה' : '☕ הפסקה';
    return bot.sendMessage(chatId,
      `⚠️ כבר יש סשן פעיל: ${label} — נשארו <b>${fmtTime(rem)}</b>\n\nשלח /pomo stop לעצור אותו קודם.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  const today    = getTodayStats();
  const cycleNum = (today.cycleCount || 0) + 1;
  const minutes  = customMinutes || WORK_MIN;

  startSession(bot, chatId, minutes, cycleNum, 'work');
}

function stopPomo(bot, chatId) {
  const key = String(chatId);
  const s   = sessions.get(key);
  if (!s) {
    return bot.sendMessage(chatId, '📭 אין סשן פעיל כרגע.').catch(() => {});
  }
  clearTimeout(s.timer);
  sessions.delete(key);
  const label = s.phase === 'work' ? '🍅 עבודה' : '☕ הפסקה';
  const rem   = remaining(s);
  bot.sendMessage(chatId,
    `🛑 <b>הסשן הופסק.</b>\n${label} — נעצר אחרי ${Math.floor((Date.now() - s.startTime) / 60000)} דקות (נשארו ${fmtTime(rem)}).`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

function statusPomo(bot, chatId) {
  const key = String(chatId);
  const s   = sessions.get(key);
  if (!s) {
    const today = getTodayStats();
    return bot.sendMessage(chatId,
      `📭 <b>אין סשן פעיל.</b>\n\n` +
      (today.sessions > 0
        ? `📊 היום: ${today.sessions} סשנים | ${today.totalMinutes} דקות מיקוד\n\n`
        : '') +
      `/pomo — התחל סשן`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  const rem     = remaining(s);
  const elapsed = s.minutes * 60 - rem;
  const pct     = Math.round(elapsed / (s.minutes * 60) * 10);
  const bar     = '█'.repeat(pct) + '░'.repeat(10 - pct);
  const emoji   = s.phase === 'work' ? '🍅' : '☕';
  const label   = s.phase === 'work' ? 'עבודה' : 'הפסקה';

  bot.sendMessage(chatId,
    `${emoji} <b>סשן ${label} פעיל — מחזור ${s.cycleNum}</b>\n\n` +
    `${bar} ${Math.round(elapsed / (s.minutes * 60) * 100)}%\n` +
    `⏱️ נשארו: <b>${fmtTime(rem)}</b> מתוך ${s.minutes} דקות\n\n` +
    `/pomo stop — עצור`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

function statsPomo(bot, chatId) {
  const today = getTodayStats();
  const all   = loadStats();
  const total = all.reduce((s, d) => s + d.sessions, 0);
  const totalMins = all.reduce((s, d) => s + d.totalMinutes, 0);

  bot.sendMessage(chatId,
    `🍅 <b>סטטיסטיקת פומודורו</b>\n\n` +
    `<b>היום:</b>\n` +
    `• ${today.sessions} סשנים | ${today.totalMinutes} דקות מיקוד\n` +
    `• ${today.cycleCount || 0} מחזורים\n\n` +
    `<b>סה"כ:</b>\n` +
    `• ${total} סשנים | ${totalMins} דקות\n` +
    `• ${Math.floor(totalMins / 60)} שעות מיקוד`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

// ── F-12 integration ──────────────────────────────────────────────────────────

function getTodayPomoStats() {
  return getTodayStats();
}

module.exports = { startPomo, stopPomo, statusPomo, statsPomo, getTodayPomoStats };
