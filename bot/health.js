'use strict';

const fs   = require('fs');
const path = require('path');

const HEALTH_FILE = path.join(__dirname, '..', 'data', 'health-log.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { return []; }
}

function save(entries) {
  fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function dateBeforeIL(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function painBar(level) {
  const filled = Math.round(level);
  const colors = ['🟢','🟢','🟢','🟡','🟡','🟡','🟠','🟠','🔴','🔴'];
  return colors.slice(0, filled).join('') + '⬜'.repeat(10 - filled) + ` ${level}/10`;
}

function moodBar(level) {
  const filled = Math.round(level);
  return '😊'.repeat(Math.min(filled, 5)) + '😔'.repeat(Math.max(0, 5 - Math.ceil(filled / 2))) + ` ${level}/10`;
}

function trendArrow(prev, curr) {
  const diff = curr - prev;
  if (Math.abs(diff) < 0.5) return '➡️';
  return diff > 0 ? '↗️' : '↘️';
}

function avg(arr) {
  if (!arr.length) return null;
  return (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1);
}

// ── Conversation state machine ────────────────────────────────────────────────
// Map<chatId, { step, data }>
const sessions = new Map();

const STEPS = ['pain', 'mood', 'sleep', 'symptoms', 'notes'];

const STEP_QUESTIONS = {
  pain:     '🩺 <b>שלב 1/5</b> — מה רמת הכאב היום? (1-10)\n\n🟢🟢🟢 = קל | 🟡🟡🟡 = בינוני | 🔴🔴🔴 = חמור',
  mood:     '😊 <b>שלב 2/5</b> — מה מצב הרוח? (1-10)\n\n1 = מאד נמוך | 5 = סביר | 10 = מצוין',
  sleep:    '💤 <b>שלב 3/5</b> — כמה שעות ישנת הלילה? (1-12)',
  symptoms: '📝 <b>שלב 4/5</b> — תסמינים מיוחדים?\n(תאר בחופשיות, או שלח "אין")',
  notes:    '💬 <b>שלב 5/5</b> — הערות נוספות?\n(תאר בחופשיות, או שלח "אין")',
};

function startCheckin(chatId) {
  sessions.set(chatId, { step: 'pain', data: {} });
  return STEP_QUESTIONS.pain;
}

function isInCheckin(chatId) {
  return sessions.has(chatId);
}

/**
 * Process a message during active check-in.
 * Returns { reply, done } where done=true means check-in is complete.
 */
function processCheckinStep(chatId, text) {
  const session = sessions.get(chatId);
  if (!session) return null;

  const { step, data } = session;
  const val = text.trim();

  if (step === 'pain') {
    const n = parseFloat(val);
    if (isNaN(n) || n < 1 || n > 10) return { reply: '⚠️ אנא הכנס מספר בין 1 ל-10.', done: false };
    data.painLevel = Math.round(n * 10) / 10;
    session.step = 'mood';
    return { reply: STEP_QUESTIONS.mood, done: false };
  }

  if (step === 'mood') {
    const n = parseFloat(val);
    if (isNaN(n) || n < 1 || n > 10) return { reply: '⚠️ אנא הכנס מספר בין 1 ל-10.', done: false };
    data.mood = Math.round(n * 10) / 10;
    session.step = 'sleep';
    return { reply: STEP_QUESTIONS.sleep, done: false };
  }

  if (step === 'sleep') {
    const n = parseFloat(val);
    if (isNaN(n) || n < 0 || n > 24) return { reply: '⚠️ אנא הכנס מספר שעות (0-24).', done: false };
    data.sleep = Math.round(n * 10) / 10;
    session.step = 'symptoms';
    return { reply: STEP_QUESTIONS.symptoms, done: false };
  }

  if (step === 'symptoms') {
    data.symptoms = val.toLowerCase() === 'אין' ? '' : val;
    session.step = 'notes';
    return { reply: STEP_QUESTIONS.notes, done: false };
  }

  if (step === 'notes') {
    data.notes = val.toLowerCase() === 'אין' ? '' : val;
    sessions.delete(chatId);

    // Save entry
    const entries = load();
    const today   = todayIL();
    const existing = entries.findIndex((e) => e.date === today);
    const entry = {
      date:       today,
      painLevel:  data.painLevel,
      mood:       data.mood,
      sleep:      data.sleep,
      symptoms:   data.symptoms,
      notes:      data.notes,
      createdAt:  new Date().toISOString(),
    };

    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
    save(entries);

    const reply =
      `✅ <b>דיווח בריאות נשמר!</b>\n\n` +
      `🩺 כאב: ${painBar(data.painLevel)}\n` +
      `😊 מצב רוח: ${moodBar(data.mood)}\n` +
      `💤 שינה: ${data.sleep} שעות\n` +
      (data.symptoms ? `📝 תסמינים: ${data.symptoms}\n` : '') +
      (data.notes    ? `💬 הערות: ${data.notes}\n`      : '');

    return { reply, done: true, entry };
  }

  return null;
}

function cancelCheckin(chatId) {
  return sessions.delete(chatId);
}

// ── Query functions ───────────────────────────────────────────────────────────
function getTodayHealth() {
  const entries = load();
  return entries.find((e) => e.date === todayIL()) || null;
}

function formatTodayStatus() {
  const entry = getTodayHealth();
  if (!entry) return '📋 לא מילאת דיווח בריאות היום.\n\nשלח /health כדי להתחיל.';

  return (
    `📋 <b>דיווח בריאות — היום</b>\n\n` +
    `🩺 כאב: ${painBar(entry.painLevel)}\n` +
    `😊 מצב רוח: ${moodBar(entry.mood)}\n` +
    `💤 שינה: ${entry.sleep} שעות\n` +
    (entry.symptoms ? `📝 תסמינים: ${entry.symptoms}\n` : '') +
    (entry.notes    ? `💬 הערות: ${entry.notes}`       : '')
  );
}

function getWeekSummary(days = 7) {
  const entries = load();
  const cutoff  = dateBeforeIL(days - 1);
  const recent  = entries.filter((e) => e.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
  if (!recent.length) return `📊 אין נתונים ל-${days} ימים האחרונים.`;

  const pains  = recent.map((e) => e.painLevel).filter(Boolean);
  const moods  = recent.map((e) => e.mood).filter(Boolean);
  const sleeps = recent.map((e) => e.sleep).filter(Boolean);

  const avgPain  = avg(pains);
  const avgMood  = avg(moods);
  const avgSleep = avg(sleeps);

  // Trend: compare first half vs second half
  const mid    = Math.floor(recent.length / 2);
  const firstP = avg(pains.slice(0, mid || 1));
  const lastP  = avg(pains.slice(mid));
  const firstM = avg(moods.slice(0, mid || 1));
  const lastM  = avg(moods.slice(mid));
  const painTrend = (firstP && lastP) ? trendArrow(parseFloat(firstP), parseFloat(lastP)) : '➡️';
  const moodTrend = (firstM && lastM) ? trendArrow(parseFloat(firstM), parseFloat(lastM)) : '➡️';

  const dayLines = recent.slice(-days).map((e) => {
    const d = new Date(e.date + 'T12:00:00').toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
    return `  ${d}: 🩺${e.painLevel} 😊${e.mood} 💤${e.sleep}ש'`;
  }).join('\n');

  return (
    `📊 <b>סיכום ${days} ימים</b> (${recent.length} דיווחים)\n\n` +
    `🩺 כאב ממוצע: <b>${avgPain}/10</b> ${painTrend}\n` +
    `😊 מצב רוח ממוצע: <b>${avgMood}/10</b> ${moodTrend}\n` +
    `💤 שינה ממוצעת: <b>${avgSleep} שעות</b>\n\n` +
    `<b>יומי:</b>\n${dayLines}`
  );
}

function formatRecentLog(count = 5) {
  const entries = load();
  const recent  = entries.slice(-count).reverse();
  if (!recent.length) return '📋 אין דיווחים עדיין.';

  const lines = recent.map((e) => {
    const d = new Date(e.date + 'T12:00:00').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
    return (
      `📅 <b>${d}</b>\n` +
      `🩺 כאב: ${painBar(e.painLevel)}  😊 מצב רוח: ${e.mood}/10  💤 ${e.sleep}ש'\n` +
      (e.symptoms ? `📝 ${e.symptoms}\n` : '') +
      (e.notes    ? `💬 ${e.notes}`     : '')
    );
  });

  return `📋 <b>${count} הדיווחים האחרונים</b>\n\n` + lines.join('\n\n─────────────\n');
}

// ── High pain alert check ─────────────────────────────────────────────────────
function checkHighPainAlert() {
  const entries = load();
  const last3   = entries.slice(-3);
  if (last3.length < 3) return null;
  const allHigh = last3.every((e) => e.painLevel >= 7);
  if (!allHigh) return null;
  const avgP = avg(last3.map((e) => e.painLevel));
  return `⚠️ <b>שים לב:</b> רמת הכאב גבוהה (${avgP}/10 בממוצע) כבר 3 ימים רצופים.\nשקול לפנות לרופא או לעדכן טיפול.`;
}

// ── Direct log (agent use — no interactive flow) ──────────────────────────────
function logDirect({ pain, mood, sleep, symptoms, notes }) {
  const entries = load();
  const today   = todayIL();
  const existing = entries.findIndex(e => e.date === today);
  const entry = {
    date:       today,
    painLevel:  pain,
    mood:       mood   || null,
    sleep:      sleep  || null,
    symptoms:   symptoms || '',
    notes:      notes    || '',
    createdAt:  new Date().toISOString(),
  };
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);
  save(entries);
  return entry;
}

// ── Yesterday missing check (for morning briefing) ───────────────────────────
function hadEntryYesterday() {
  const yesterday = dateBeforeIL(1);
  const entries   = load();
  return entries.some((e) => e.date === yesterday);
}

module.exports = {
  startCheckin,
  isInCheckin,
  processCheckinStep,
  cancelCheckin,
  logDirect,
  getTodayHealth,
  getWeekSummary,
  formatTodayStatus,
  formatRecentLog,
  checkHighPainAlert,
  hadEntryYesterday,
};
