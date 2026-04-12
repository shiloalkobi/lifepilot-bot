'use strict';

const fs   = require('fs');
const path = require('path');

const HABITS_FILE = path.join(__dirname, '..', 'data', 'habits.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(HABITS_FILE, 'utf8')); } catch { return []; }
}

function save(habits) {
  fs.mkdirSync(path.dirname(HABITS_FILE), { recursive: true });
  fs.writeFileSync(HABITS_FILE, JSON.stringify(habits, null, 2), 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function nextId(habits) {
  return habits.length ? Math.max(...habits.map(h => h.id)) + 1 : 1;
}

// Calculate current streak (consecutive days logged as done up to today)
function calcStreak(habit) {
  const today   = todayIL();
  const doneSet = new Set((habit.logs || []).filter(l => l.done).map(l => l.date));

  let streak = 0;
  const d = new Date(today + 'T12:00:00');

  while (true) {
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    if (doneSet.has(dateStr)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      // Allow today to be missing (not yet logged) — only break if it's a past day
      if (dateStr === today) { d.setDate(d.getDate() - 1); continue; }
      break;
    }
  }
  return streak;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
function addHabit(name, icon = '✅', frequency = 'daily') {
  const habits = load();
  const habit = {
    id:        nextId(habits),
    name,
    icon:      icon || '✅',
    frequency: frequency || 'daily',
    createdAt: new Date().toISOString(),
    logs:      [],
  };
  habits.push(habit);
  save(habits);
  return habit;
}

function deleteHabit(id) {
  const habits = load();
  const idx    = habits.findIndex(h => h.id === id);
  if (idx === -1) return null;
  const [removed] = habits.splice(idx, 1);
  save(habits);
  return removed;
}

function logHabit(id, done = true, date = null) {
  const habits = load();
  const habit  = habits.find(h => h.id === id);
  if (!habit) return null;

  const logDate = date || todayIL();
  const existing = (habit.logs || []).findIndex(l => l.date === logDate);
  const entry = { date: logDate, done, loggedAt: new Date().toISOString() };

  if (existing >= 0) habit.logs[existing] = entry;
  else habit.logs.push(entry);

  save(habits);
  return { habit, streak: calcStreak(habit) };
}

function getHabits() {
  return load().map(h => ({ ...h, streak: calcStreak(h) }));
}

// ── Formatting ────────────────────────────────────────────────────────────────
function formatHabits() {
  const today  = todayIL();
  const habits = load();
  if (!habits.length) return '📋 אין הרגלים מוגדרים עדיין.\n\nהוסף הרגל: "תוסיף הרגל: שתיית מים"';

  const lines = ['📋 <b>הרגלים שלי</b>\n'];

  for (const h of habits) {
    const todayLog  = (h.logs || []).find(l => l.date === today);
    const doneToday = todayLog?.done ?? false;
    const streak    = calcStreak(h);
    const streakStr = streak > 0 ? ` 🔥 ${streak}` : '';
    const status    = doneToday ? '✅' : '⬜';
    lines.push(`${status} ${h.icon} <b>${h.name}</b>${streakStr} (ID: ${h.id})`);
  }

  const totalToday = habits.filter(h => (h.logs || []).find(l => l.date === today && l.done)).length;
  lines.push(`\n<b>${totalToday}/${habits.length}</b> הרגלים בוצעו היום`);

  return lines.join('\n');
}

function getTodayHabitSummary() {
  const today  = todayIL();
  const habits = load();
  if (!habits.length) return null;

  const done    = habits.filter(h => (h.logs || []).find(l => l.date === today && l.done)).length;
  const pending = habits.filter(h => !(h.logs || []).find(l => l.date === today && l.done));
  return { total: habits.length, done, pending };
}

module.exports = {
  addHabit,
  deleteHabit,
  logHabit,
  getHabits,
  formatHabits,
  getTodayHabitSummary,
};
