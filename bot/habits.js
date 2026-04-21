'use strict';

const fs   = require('fs');
const path = require('path');
const { supabase, isEnabled } = require('./supabase');

const HABITS_FILE = path.join(__dirname, '..', 'data', 'habits.json');

// ── JSON fallback ─────────────────────────────────────────────────────────────
function loadFromJson() {
  try { return JSON.parse(fs.readFileSync(HABITS_FILE, 'utf8')); } catch { return []; }
}

function saveToJson(habits) {
  try {
    fs.mkdirSync(path.dirname(HABITS_FILE), { recursive: true });
    fs.writeFileSync(HABITS_FILE, JSON.stringify(habits, null, 2), 'utf8');
  } catch (e) {
    console.warn('[habits] JSON save failed:', e.message);
  }
}

function rowToHabit(r) {
  return {
    id:        r.id,
    name:      r.name,
    icon:      r.icon || '✅',
    frequency: r.frequency || 'daily',
    createdAt: r.created_at,
    logs:      Array.isArray(r.logs) ? r.logs : [],
  };
}

async function load() {
  if (isEnabled()) {
    const { data, error } = await supabase
      .from('habits')
      .select('*')
      .order('id', { ascending: true });
    if (!error && Array.isArray(data)) return data.map(rowToHabit);
    if (error) console.warn('[Supabase] habits load error:', error.message);
  }
  return loadFromJson();
}

async function upsertHabit(habit) {
  if (isEnabled()) {
    const { error } = await supabase.from('habits').upsert({
      id:         habit.id,
      name:       habit.name,
      icon:       habit.icon,
      frequency:  habit.frequency,
      created_at: habit.createdAt,
      logs:       habit.logs || [],
    }, { onConflict: 'id' });
    if (error) console.warn('[Supabase] habits upsert error:', error.message);
  }

  const habits = loadFromJson();
  const idx = habits.findIndex(h => h.id === habit.id);
  if (idx >= 0) habits[idx] = habit;
  else habits.push(habit);
  saveToJson(habits);
}

async function deleteHabitRow(id) {
  if (isEnabled()) {
    const { error } = await supabase.from('habits').delete().eq('id', id);
    if (error) console.warn('[Supabase] habits delete error:', error.message);
  }
  const habits = loadFromJson();
  const filtered = habits.filter(h => h.id !== id);
  saveToJson(filtered);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function nextId(habits) {
  return habits.length ? Math.max(...habits.map(h => h.id)) + 1 : 1;
}

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
      if (dateStr === today) { d.setDate(d.getDate() - 1); continue; }
      break;
    }
  }
  return streak;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
async function addHabit(name, icon = '✅', frequency = 'daily') {
  const habits = await load();
  const habit = {
    id:        nextId(habits),
    name,
    icon:      icon || '✅',
    frequency: frequency || 'daily',
    createdAt: new Date().toISOString(),
    logs:      [],
  };
  await upsertHabit(habit);
  return habit;
}

async function deleteHabit(id) {
  const habits = await load();
  const found  = habits.find(h => h.id === id);
  if (!found) return null;
  await deleteHabitRow(id);
  return found;
}

async function logHabit(id, done = true, date = null) {
  const habits = await load();
  const habit  = habits.find(h => h.id === id);
  if (!habit) return null;

  const logDate = date || todayIL();
  const logs = Array.isArray(habit.logs) ? [...habit.logs] : [];
  const existing = logs.findIndex(l => l.date === logDate);
  const entry = { date: logDate, done, loggedAt: new Date().toISOString() };

  if (existing >= 0) logs[existing] = entry;
  else logs.push(entry);

  habit.logs = logs;
  await upsertHabit(habit);
  return { habit, streak: calcStreak(habit) };
}

async function getHabits() {
  const habits = await load();
  return habits.map(h => ({ ...h, streak: calcStreak(h) }));
}

// ── Formatting ────────────────────────────────────────────────────────────────
async function formatHabits() {
  const today  = todayIL();
  const habits = await load();
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

async function getTodayHabitSummary() {
  const today  = todayIL();
  const habits = await load();
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
