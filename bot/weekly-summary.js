'use strict';

const fs   = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { canCall, increment } = require('./rate-limiter');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function dateBeforeIL(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function weekRangeHebrew() {
  const end   = new Date();
  const start = new Date(); start.setDate(end.getDate() - 6);
  const fmt   = (d) => d.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function avg(arr) {
  if (!arr.length) return null;
  return (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1);
}

// ── Data collectors ───────────────────────────────────────────────────────────

function collectTasks() {
  try {
    const DATA = path.join(__dirname, '..', 'data', 'tasks.json');
    const tasks = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const cutoff = dateBeforeIL(6);
    const completedThisWeek = tasks.filter(
      (t) => t.done && t.doneAt && t.doneAt.slice(0, 10) >= cutoff
    );
    const open = tasks.filter((t) => !t.done);
    return { completed: completedThisWeek.length, open: open.length };
  } catch { return null; }
}

function collectHealth() {
  try {
    const DATA = path.join(__dirname, '..', 'data', 'health.json');
    const entries = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const cutoff  = dateBeforeIL(6);
    const week    = entries.filter((e) => e.date >= cutoff);
    if (!week.length) return null;
    const pains  = week.map((e) => e.painLevel).filter(Boolean);
    const moods  = week.map((e) => e.mood).filter(Boolean);
    const sleeps = week.map((e) => e.sleep).filter(Boolean);
    // Trend: first half vs second half of the week
    const mid = Math.floor(pains.length / 2) || 1;
    const painTrend = pains.length >= 2
      ? (parseFloat(avg(pains.slice(mid))) < parseFloat(avg(pains.slice(0, mid))) ? '📉' : '📈')
      : '➡️';
    return {
      days: week.length,
      avgPain:  avg(pains),
      avgMood:  avg(moods),
      avgSleep: avg(sleeps),
      painTrend,
    };
  } catch { return null; }
}

function collectMeds() {
  try {
    const DATA = path.join(__dirname, '..', 'data', 'medications.json');
    const meds  = JSON.parse(fs.readFileSync(DATA, 'utf8')).filter((m) => m.enabled);
    if (!meds.length) return null;
    const cutoff = dateBeforeIL(6);
    let total = 0, taken = 0;
    for (const med of meds) {
      for (const log of (med.log || [])) {
        if (log.date >= cutoff) {
          total++;
          if (log.status === 'taken') taken++;
        }
      }
    }
    if (total === 0) return null;
    return { pct: Math.round(taken / total * 100), taken, total };
  } catch { return null; }
}

function collectEnglish() {
  try {
    const DATA = path.join(__dirname, '..', 'data', 'english-progress.json');
    const prog  = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const cutoff = dateBeforeIL(6);
    const daysThisWeek = (prog.dates || []).filter((d) => d >= cutoff).length;
    const streak = (() => {
      const sorted = [...(prog.dates || [])].sort().reverse();
      const today  = todayIL();
      if (!sorted.length || (sorted[0] !== today && sorted[0] !== dateBeforeIL(1))) return 0;
      let s = 1;
      for (let i = 1; i < sorted.length; i++) {
        const prev = new Date(sorted[i-1] + 'T12:00:00');
        const curr = new Date(sorted[i]   + 'T12:00:00');
        if (Math.round((prev - curr) / 86400000) === 1) s++; else break;
      }
      return s;
    })();
    const wordsTotal = (prog.wordsLearned || []).length;
    return { daysThisWeek, streak, wordsTotal };
  } catch { return null; }
}

function collectPomo() {
  try {
    const DATA  = path.join(__dirname, '..', 'data', 'pomodoro.json');
    const stats = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const cutoff = dateBeforeIL(6);
    const week  = stats.filter((s) => s.date >= cutoff);
    if (!week.length) return null;
    return {
      sessions:     week.reduce((s, d) => s + d.sessions, 0),
      totalMinutes: week.reduce((s, d) => s + d.totalMinutes, 0),
      days:         week.length,
    };
  } catch { return null; }
}

// ── AI weekly insight ─────────────────────────────────────────────────────────

async function generateWeeklyInsight(data) {
  if (!canCall()) return null;
  increment();

  const lines = [];
  if (data.tasks)   lines.push(`משימות: ${data.tasks.completed} הושלמו, ${data.tasks.open} פתוחות`);
  if (data.health)  lines.push(`בריאות: כאב ממוצע ${data.health.avgPain}, מצב רוח ${data.health.avgMood}, שינה ${data.health.avgSleep}ש' (${data.health.days}/7 ימי דיווח)`);
  if (data.meds)    lines.push(`תרופות: ${data.meds.pct}% compliance (${data.meds.taken}/${data.meds.total})`);
  if (data.english) lines.push(`אנגלית: ${data.english.daysThisWeek}/7 ימי תרגול, רצף ${data.english.streak} ימים`);
  if (data.pomo)    lines.push(`פומודורו: ${data.pomo.sessions} סשנים, ${data.pomo.totalMinutes} דקות מיקוד`);
  if (!lines.length) return null;

  try {
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(
      `נתוני השבוע של שילה אלקובי:\n${lines.join('\n')}\n\n` +
      `כתוב 2-3 המלצות קצרות ואקציונביליות לשבוע הבא בעברית. ` +
      `התייחס לנתונים הספציפיים. טון חם, מעשי, ממוקד. ללא כותרת.`
    );
    return result.response.text().trim();
  } catch (err) {
    console.error('[Weekly] AI insight error:', err.message);
    return null;
  }
}

// ── Build message ─────────────────────────────────────────────────────────────

async function buildWeeklySummaryMessage() {
  const data = {
    tasks:   collectTasks(),
    health:  collectHealth(),
    meds:    collectMeds(),
    english: collectEnglish(),
    pomo:    collectPomo(),
  };

  const lines = [`📊 <b>סיכום שבועי — ${weekRangeHebrew()}</b>\n`];

  // Tasks
  if (data.tasks) {
    lines.push(`✅ <b>משימות:</b> ${data.tasks.completed} הושלמו השבוע | ${data.tasks.open} פתוחות`);
  } else {
    lines.push(`✅ <b>משימות:</b> אין נתונים`);
  }

  // Health
  if (data.health) {
    const { avgPain, avgMood, avgSleep, painTrend, days } = data.health;
    lines.push(
      `🩺 <b>בריאות (${days}/7 ימים):</b>\n` +
      `   כאב: ${avgPain || '—'}/10 ${painTrend} | מצב רוח: ${avgMood || '—'}/10 | שינה: ${avgSleep || '—'}ש'`
    );
  } else {
    lines.push(`🩺 <b>בריאות:</b> לא דווח השבוע`);
  }

  // Medications
  if (data.meds) {
    const icon = data.meds.pct >= 80 ? '✅' : data.meds.pct >= 50 ? '⚠️' : '❌';
    lines.push(`💊 <b>תרופות:</b> ${icon} ${data.meds.pct}% compliance (${data.meds.taken}/${data.meds.total})`);
  } else {
    lines.push(`💊 <b>תרופות:</b> לא הוגדרו`);
  }

  // English
  if (data.english) {
    const { daysThisWeek, streak, wordsTotal } = data.english;
    lines.push(`📚 <b>אנגלית:</b> ${daysThisWeek}/7 ימי תרגול | רצף ${streak} ימים 🔥 | ${wordsTotal} מילים סה"כ`);
  } else {
    lines.push(`📚 <b>אנגלית:</b> לא דווח`);
  }

  // Pomodoro
  if (data.pomo) {
    lines.push(`🍅 <b>פומודורו:</b> ${data.pomo.sessions} סשנים | ${data.pomo.totalMinutes} דקות מיקוד | ${data.pomo.days} ימים פעיל`);
  } else {
    lines.push(`🍅 <b>פומודורו:</b> לא בוצע`);
  }

  // AI insight
  const insight = await generateWeeklyInsight(data);
  if (insight) {
    lines.push(`\n💡 <b>המלצות לשבוע הבא:</b>\n${insight}`);
  }

  lines.push(`\n🗓️ <i>שבוע טוב!</i>`);

  return lines.join('\n');
}

module.exports = { buildWeeklySummaryMessage };
