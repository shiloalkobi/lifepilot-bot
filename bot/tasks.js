'use strict';

const fs   = require('fs');
const path = require('path');
const { supabase, isEnabled } = require('./supabase');

const TASKS_FILE = path.join(__dirname, '..', 'data', 'tasks.json');

// ── JSON fallback ─────────────────────────────────────────────────────────────
function loadFromJson() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { return []; }
}

function saveToJson(tasks) {
  try {
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  } catch (e) {
    console.warn('[tasks] JSON save failed:', e.message);
  }
}

function rowToTask(r) {
  return {
    id:        r.id,
    text:      r.text,
    done:      !!r.done,
    priority:  r.priority || 'medium',
    createdAt: r.created_at,
    doneAt:    r.done_at || null,
  };
}

async function loadTasks() {
  if (isEnabled()) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .order('id', { ascending: true });
    if (!error && Array.isArray(data)) return data.map(rowToTask);
    if (error) console.warn('[Supabase] tasks load error:', error.message);
  }
  return loadFromJson();
}

async function upsertTask(task) {
  if (isEnabled()) {
    const { error } = await supabase.from('tasks').upsert({
      id:         task.id,
      text:       task.text,
      done:       task.done,
      priority:   task.priority,
      created_at: task.createdAt,
      done_at:    task.doneAt,
    }, { onConflict: 'id' });
    if (error) console.warn('[Supabase] tasks upsert error:', error.message);
  }

  const tasks = loadFromJson();
  const idx = tasks.findIndex(t => t.id === task.id);
  if (idx >= 0) tasks[idx] = task;
  else tasks.push(task);
  saveToJson(tasks);
}

async function deleteTaskRow(id) {
  if (isEnabled()) {
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) console.warn('[Supabase] tasks delete error:', error.message);
  }
  const tasks = loadFromJson();
  saveToJson(tasks.filter(t => t.id !== id));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

function sortByPriority(tasks) {
  return [...tasks].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

function nextId(tasks) {
  return tasks.length === 0 ? 1 : Math.max(...tasks.map((t) => t.id)) + 1;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
async function addTask(text) {
  const tasks = await loadTasks();
  const isHigh = text.startsWith('!');
  const cleanText = isHigh ? text.slice(1).trim() : text.trim();
  if (!cleanText) return null;

  const task = {
    id: nextId(tasks),
    text: cleanText,
    done: false,
    priority: isHigh ? 'high' : 'medium',
    createdAt: new Date().toISOString(),
    doneAt: null,
  };
  await upsertTask(task);
  return task;
}

async function markDone(index) {
  const tasks = await loadTasks();
  const open = sortByPriority(tasks.filter((t) => !t.done));
  const task = open[index - 1];
  if (!task) return null;

  task.done = true;
  task.doneAt = new Date().toISOString();
  await upsertTask(task);
  return task;
}

async function markUndone(index) {
  const tasks = await loadTasks();
  const done = tasks.filter((t) => t.done);
  const task = done[index - 1];
  if (!task) return null;

  task.done = false;
  task.doneAt = null;
  await upsertTask(task);
  return task;
}

async function deleteTask(index) {
  const tasks = await loadTasks();
  const open = sortByPriority(tasks.filter((t) => !t.done));
  const task = open[index - 1];
  if (!task) return null;
  await deleteTaskRow(task.id);
  return task;
}

async function clearCompleted() {
  const tasks = await loadTasks();
  const completed = tasks.filter(t => t.done);
  for (const t of completed) {
    await deleteTaskRow(t.id);
  }
  return completed.length;
}

// ── Formatting ────────────────────────────────────────────────────────────────
const PRIORITY_EMOJI = { high: '📌', medium: '🔲', low: '⬜' };

async function formatOpenTasks() {
  const tasks = await loadTasks();
  const open  = sortByPriority(tasks.filter((t) => !t.done));

  if (open.length === 0) return '✅ אין משימות פתוחות. יאללה לנוח! 🎉';

  const lines = open.map((t, i) => {
    const emoji = PRIORITY_EMOJI[t.priority];
    const high  = t.priority === 'high' ? ' <b>[דחוף]</b>' : '';
    return `${i + 1}. ${emoji} ${t.text}${high}`;
  });

  return `📋 <b>משימות פתוחות (${open.length})</b>\n\n${lines.join('\n')}\n\n<i>/done N — סמן כבוצע | /deltask N — מחק</i>`;
}

// ── Exports for F-12 daily summary ───────────────────────────────────────────
async function getOpenTasks() {
  const tasks = await loadTasks();
  return sortByPriority(tasks.filter((t) => !t.done));
}

async function getCompletedToday() {
  const tasks  = await loadTasks();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return tasks.filter((t) => t.done && t.doneAt && new Date(t.doneAt) >= todayStart);
}

module.exports = {
  addTask,
  markDone,
  markUndone,
  deleteTask,
  clearCompleted,
  formatOpenTasks,
  getOpenTasks,
  getCompletedToday,
};
