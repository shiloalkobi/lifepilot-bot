'use strict';

const fs   = require('fs');
const path = require('path');
const { supabase, isEnabled } = require('./supabase');

const HABITS_FILE = path.join(__dirname, '..', 'data', 'habits.json');
const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null;

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

// Unpack unified schema row → in-memory habit (numeric id).
function rowToHabit(r) {
  const d = r.data || {};
  return {
    id:        Number(r.id),
    name:      d.name,
    icon:      d.icon || '✅',
    frequency: d.frequency || 'daily',
    createdAt: r.created_at,
    logs:      Array.isArray(d.logs) ? d.logs : [],
  };
}

async function load() {
  if (isEnabled()) {
    const { data, error } = await supabase
      .from('habits')
      .select('*');
    if (!error && Array.isArray(data)) {
      return data.map(rowToHabit).sort((a, b) => a.id - b.id);
    }
    if (error) console.warn('[Supabase] habits load error:', error.message);
  }
  return loadFromJson();
}

async function upsertHabit(habit) {
  if (isEnabled()) {
    if (!OWNER_CHAT_ID) console.warn('[habits] TELEGRAM_CHAT_ID missing — row will have NULL chat_id');
    const { error } = await supabase.from('habits').upsert({
      id:         String(habit.id),
      chat_id:    OWNER_CHAT_ID,
      data: {
        name:          habit.name,
        icon:          habit.icon,
        frequency:     habit.frequency,
        logs:          habit.logs || [],
      },
      created_at: habit.createdAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) console.warn('[Supabase] habits upsert error:', error.message);
  }

  const habits = loadFromJson();
  const idx = habits.findIndex(h => h.id === habit.id);
  if (idx >= 0) habits[idx] = habit;
  else habits.push(habit);
  saveToJson(habits);

  try { require('./metrics-history').invalidateCache(OWNER_CHAT_ID); } catch {}
}

async function deleteHabitRow(id) {
  if (isEnabled()) {
    const { error } = await supabase.from('habits').delete().eq('id', String(id));
    if (error) console.warn('[Supabase] habits delete error:', error.message);
  }
  const habits = loadFromJson();
  const filtered = habits.filter(h => h.id !== id);
  saveToJson(filtered);

  try { require('./metrics-history').invalidateCache(OWNER_CHAT_ID); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

// Query Supabase directly for max id to avoid collisions when local JSON is
// empty (e.g. after a Render redeploy) but Supabase has existing rows.
async function nextId() {
  if (isEnabled()) {
    const { data, error } = await supabase.from('habits').select('id');
    if (!error && Array.isArray(data) && data.length) {
      return Math.max(...data.map(r => Number(r.id) || 0)) + 1;
    }
  }
  const local = loadFromJson();
  return local.length ? Math.max(...local.map(h => Number(h.id) || 0)) + 1 : 1;
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

  // Duplicate prevention — match by name (case-insensitive, trimmed)
  const norm = String(name || '').toLowerCase().trim();
  const dup  = habits.find(h => (h.name || '').toLowerCase().trim() === norm);
  if (dup) return { ...dup, isDuplicate: true };

  const habit = {
    id:        await nextId(),
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
