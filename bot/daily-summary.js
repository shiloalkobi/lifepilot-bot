'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getOpenTasks, getCompletedToday } = require('./tasks');
const { getTodayHealth } = require('./health');
const { getTodayMedStatus } = require('./medications');
const { getDailyWordSync, getStreak } = require('./english');
const { getTodayPomoStats }           = require('./pomodoro');
const { canCall, increment }          = require('./rate-limiter');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIL(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function todayHebrew(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ── Collect all data ──────────────────────────────────────────────────────────

function collectData(offsetDays = 0) {
  const isToday = offsetDays === 0;

  // Tasks (always "today" relative to now — past day offset not supported in task store)
  const completedTasks = isToday ? getCompletedToday() : [];
  const openTasks      = getOpenTasks();

  // Health
  const health = (() => {
    if (!isToday) return null;
    return getTodayHealth(); // returns null if no check-in
  })();

  // Medications
  const meds = (() => {
    try { return getTodayMedStatus(); } catch { return null; }
  })();

  // English
  const english = (() => {
    try {
      const word   = getDailyWordSync();
      const streak = getStreak();
      return { word, streak };
    } catch { return null; }
  })();

  // Pomodoro
  const pomo = (() => {
    try { return getTodayPomoStats(); } catch { return null; }
  })();

  return { completedTasks, openTasks, health, meds, english, pomo };
}

// ── AI insight ────────────────────────────────────────────────────────────────

async function generateInsight(data) {
  if (!canCall()) return null;
  increment();

  const { completedTasks, openTasks, health, meds, pomo } = data;

  const lines = [];
  if (completedTasks.length > 0 || openTasks.length > 0) {
    lines.push(`משימות: ${completedTasks.length} הושלמו, ${openTasks.length} פתוחות`);
  }
  if (health) {
    lines.push(`בריאות: כאב ${health.painLevel}/10, מצב רוח ${health.mood}/10, שינה ${health.sleep} שעות`);
    if (health.symptoms) lines.push(`תסמינים: ${health.symptoms}`);
    if (health.notes)    lines.push(`הערות: ${health.notes}`);
  }
  if (meds && meds.total > 0) {
    lines.push(`תרופות: ${meds.taken}/${meds.total} נלקחו`);
  }
  if (pomo && pomo.sessions > 0) {
    lines.push(`פומודורו: ${pomo.sessions} סשנים, ${pomo.totalMinutes} דקות מיקוד`);
  }

  if (lines.length === 0) return null;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt =
      `נתוני היום של שילה אלקובי:\n${lines.join('\n')}\n\n` +
      `כתוב תובנה אישית קצרה (2-3 משפטים בעברית) — מה השיג/ה היום, מה לשים לב אליו מחר, ` +
      `או המלצה קטנה. ללא כותרת, ישירות לעניין. טון חם ועידוד.`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[Summary] AI insight error:', err.message);
    return null;
  }
}

// ── Format the summary message ────────────────────────────────────────────────

async function buildSummaryMessage(offsetDays = 0) {
  const dateStr = todayHebrew(offsetDays);
  const data    = collectData(offsetDays);
  const { completedTasks, openTasks, health, meds, english, pomo } = data;

  const lines = [`📊 <b>סיכום יומי — ${dateStr}</b>\n`];

  // ── Tasks ──
  if (completedTasks.length > 0 || openTasks.length > 0) {
    const doneStr = completedTasks.length > 0
      ? `${completedTasks.length} הושלמו`
      : '0 הושלמו';
    const openStr = openTasks.length > 0
      ? `${openTasks.length} פתוחות`
      : 'הכל בוצע 🎉';
    lines.push(`✅ <b>משימות:</b> ${doneStr} | ${openStr}`);
  } else {
    lines.push(`✅ <b>משימות:</b> לא דווח`);
  }

  // ── Health ──
  if (health) {
    const sleepStr = health.sleep ? `שינה ${health.sleep} שעות` : 'שינה לא דווחה';
    lines.push(
      `🩺 <b>בריאות:</b> כאב ${health.painLevel}/10 | מצב רוח ${health.mood}/10 | ${sleepStr}`
    );
  } else {
    lines.push(`🩺 <b>בריאות:</b> לא דווח`);
  }

  // ── Medications ──
  if (meds && meds.total > 0) {
    const parts = [`${meds.taken}/${meds.total} נלקחו`];
    if (meds.missed  > 0) parts.push(`${meds.missed} פוספסו`);
    if (meds.skipped > 0) parts.push(`${meds.skipped} דולגו`);
    if (meds.pending > 0) parts.push(`${meds.pending} ממתינות`);
    lines.push(`💊 <b>תרופות:</b> ${parts.join(' | ')}`);
  } else {
    lines.push(`💊 <b>תרופות:</b> לא הוגדרו`);
  }

  // ── English ──
  if (english) {
    const { word, streak } = english;
    const practiced = streak > 0;
    const streakStr = streak > 0 ? `רצף ${streak} ימים 🔥` : 'אין רצף';
    lines.push(
      `📚 <b>אנגלית:</b> ${practiced ? '✅ תורגלה' : 'לא דווח'} | ${streakStr}` +
      (word ? ` | מילה: <i>${word.word}</i>` : '')
    );
  } else {
    lines.push(`📚 <b>אנגלית:</b> לא דווח`);
  }

  // ── Pomodoro ──
  if (pomo && pomo.sessions > 0) {
    lines.push(`🍅 <b>פומודורו:</b> ${pomo.sessions} סשנים | ${pomo.totalMinutes} דקות מיקוד`);
  } else {
    lines.push(`🍅 <b>פומודורו:</b> לא בוצע`);
  }

  // ── AI insight ──
  const insight = await generateInsight(data);
  if (insight) {
    lines.push(`\n💡 <b>תובנה:</b> ${insight}`);
  }

  lines.push(`\n🌙 לילה טוב, שילה!`);

  return lines.join('\n');
}

module.exports = { buildSummaryMessage };
