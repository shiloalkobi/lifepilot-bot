'use strict';

const fs   = require('fs');
const path = require('path');

const TASKS_FILE = path.join(__dirname, '..', 'data', 'tasks.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadTasks() {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
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
function addTask(text) {
  const tasks = loadTasks();
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
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

function markDone(index) {
  const tasks = loadTasks();
  const open = sortByPriority(tasks.filter((t) => !t.done));
  const task = open[index - 1];
  if (!task) return null;

  const real = tasks.find((t) => t.id === task.id);
  real.done  = true;
  real.doneAt = new Date().toISOString();
  saveTasks(tasks);
  return real;
}

function markUndone(index) {
  const tasks = loadTasks();
  const done = tasks.filter((t) => t.done);
  const task = done[index - 1];
  if (!task) return null;

  const real = tasks.find((t) => t.id === task.id);
  real.done  = false;
  real.doneAt = null;
  saveTasks(tasks);
  return real;
}

function deleteTask(index) {
  const tasks = loadTasks();
  const open = sortByPriority(tasks.filter((t) => !t.done));
  const task = open[index - 1];
  if (!task) return null;

  const filtered = tasks.filter((t) => t.id !== task.id);
  saveTasks(filtered);
  return task;
}

function clearCompleted() {
  const tasks = loadTasks();
  const remaining = tasks.filter((t) => !t.done);
  const removed = tasks.length - remaining.length;
  saveTasks(remaining);
  return removed;
}

// ── Formatting ────────────────────────────────────────────────────────────────
const PRIORITY_EMOJI = { high: '📌', medium: '🔲', low: '⬜' };

function formatOpenTasks() {
  const tasks = loadTasks();
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
function getOpenTasks() {
  const tasks = loadTasks();
  return sortByPriority(tasks.filter((t) => !t.done));
}

function getCompletedToday() {
  const tasks  = loadTasks();
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
