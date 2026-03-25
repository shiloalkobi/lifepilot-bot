'use strict';

const fs   = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { canCall, increment } = require('./rate-limiter');

const DATA_FILE = path.join(__dirname, '..', 'data', 'reminders.json');
const genAI     = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Storage ───────────────────────────────────────────────────────────────────

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function save(reminders) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(reminders, null, 2), 'utf8');
}

function nextId(reminders) {
  return reminders.length === 0 ? 1 : Math.max(...reminders.map((r) => r.id)) + 1;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function nowIL() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}

function formatTimeIL(isoStr) {
  return new Date(isoStr).toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── AI Parser ─────────────────────────────────────────────────────────────────

async function parseReminder(text) {
  if (!canCall()) return null;
  increment();

  const nowStr = nowIL();

  const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-001' });
  const prompt =
    `עכשיו: ${nowStr} (שעון ישראל, UTC+3).\n` +
    `המשתמש אומר: "${text}"\n\n` +
    `חלץ את התזכורת. החזר JSON בלבד (ללא markdown, ללא הסברים):\n` +
    `{\n` +
    `  "task": "מה לבצע (עברית או אנגלית כפי שנאמר)",\n` +
    `  "remindAt": "ISO8601 datetime בשעון ישראל, לדוגמה: 2026-03-23T15:00:00",\n` +
    `  "understood": true\n` +
    `}\n\n` +
    `אם לא הבנת את הזמן, החזר: { "understood": false }\n` +
    `זמנים יחסיים: "בעוד שעה", "בעוד 30 דקות", "מחר", "ביום רביעי".\n` +
    `זמנים מוחלטים: "ב-14:00", "at 3pm", "ב-9 בבוקר".\n` +
    `אל תוסיף שום טקסט מחוץ ל-JSON.`;

  try {
    const result  = await model.generateContent(prompt);
    const raw     = result.response.text().trim();
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (!parsed.understood) return null;
    if (!parsed.task || !parsed.remindAt) return null;
    // Validate the datetime is parseable
    const dt = new Date(parsed.remindAt);
    if (isNaN(dt.getTime())) return null;
    if (dt < new Date()) return null; // must be in the future
    return { task: parsed.task, remindAt: parsed.remindAt };
  } catch (err) {
    console.error('[Reminders] Parse error:', err.message);
    return null;
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function addReminder(chatId, text) {
  const parsed = await parseReminder(text);
  if (!parsed) return null;

  const reminders = load();
  const reminder  = {
    id:        nextId(reminders),
    task:      parsed.task,
    remindAt:  parsed.remindAt,
    chatId:    String(chatId),
    createdAt: new Date().toISOString(),
    sent:      false,
  };
  reminders.push(reminder);
  save(reminders);
  return reminder;
}

function listPending(chatId) {
  return load()
    .filter((r) => String(r.chatId) === String(chatId) && !r.sent)
    .sort((a, b) => new Date(a.remindAt) - new Date(b.remindAt));
}

function deleteReminder(chatId, id) {
  const reminders = load();
  const idx = reminders.findIndex((r) => r.id === id && String(r.chatId) === String(chatId));
  if (idx === -1) return false;
  reminders.splice(idx, 1);
  save(reminders);
  return true;
}

// ── Format pending list ───────────────────────────────────────────────────────

function formatPending(chatId) {
  const pending = listPending(chatId);
  if (pending.length === 0) return '📭 אין תזכורות ממתינות.\n\nשלח /remind [טקסט] להוספת תזכורת.';

  const lines = pending.map((r, i) =>
    `${i + 1}. ⏰ <b>${r.task}</b>\n   📅 ${formatTimeIL(r.remindAt)} <i>(ID: ${r.id})</i>`
  );
  return `⏰ <b>תזכורות ממתינות (${pending.length}):</b>\n\n${lines.join('\n\n')}\n\n<i>/delremind [מספר] למחיקה</i>`;
}

// ── Direct add (agent use — no Gemini parsing) ────────────────────────────────
function addReminderDirect(chatId, task, remindAt) {
  const dt = new Date(remindAt);
  if (isNaN(dt.getTime()) || dt <= new Date()) return null;
  const reminders = load();
  const reminder  = {
    id:        nextId(reminders),
    task,
    remindAt,
    chatId:    String(chatId),
    createdAt: new Date().toISOString(),
    sent:      false,
  };
  reminders.push(reminder);
  save(reminders);
  return reminder;
}

// ── Scheduler: check every 30s, fire due reminders ───────────────────────────

function startReminderScheduler(bot) {
  // Restore timers for reminders that are still in the future
  function scheduleReminder(reminder) {
    const delay = new Date(reminder.remindAt) - Date.now();
    if (delay <= 0) return; // already overdue — fire on next poll cycle
    setTimeout(() => fireReminder(bot, reminder), delay);
  }

  function fireReminder(bot, reminder) {
    const reminders = load();
    const r = reminders.find((x) => x.id === reminder.id);
    if (!r || r.sent) return; // already fired or deleted

    r.sent = true;
    save(reminders);

    bot.sendMessage(r.chatId,
      `⏰ <b>תזכורת:</b> ${r.task}`,
      { parse_mode: 'HTML' }
    ).catch((err) => console.error('[Reminders] Fire error:', err.message));

    console.log(`[Reminders] Fired #${r.id}: ${r.task}`);
  }

  // On startup: schedule all pending reminders that are in the future
  const pending = load().filter((r) => !r.sent && new Date(r.remindAt) > new Date());
  pending.forEach((r) => scheduleReminder(r));
  console.log(`[Reminders] Restored ${pending.length} pending reminders`);

  // Poll every 30s to catch any that slipped through (Render restart edge case)
  setInterval(() => {
    const now = new Date();
    const due = load().filter((r) => !r.sent && new Date(r.remindAt) <= now);
    for (const r of due) {
      fireReminder(bot, r);
    }
  }, 30 * 1000);
}

module.exports = {
  addReminder,
  addReminderDirect,
  listPending,
  deleteReminder,
  formatPending,
  startReminderScheduler,
  formatTimeIL,
};
