'use strict';

const fs   = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { canCall, increment } = require('./rate-limiter');

const DATA_FILE = path.join(__dirname, '..', 'data', 'notes.json');
const genAI     = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Storage ───────────────────────────────────────────────────────────────────

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function save(notes) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(notes, null, 2), 'utf8');
}

function nextId(notes) {
  return notes.length === 0 ? 1 : Math.max(...notes.map((n) => n.id)) + 1;
}

// ── AI tagging ────────────────────────────────────────────────────────────────

async function suggestTags(content) {
  if (!canCall()) return [];
  increment();
  try {
    const model  = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    const result = await model.generateContent(
      `הערה הבאה נשמרה על ידי מפתח:\n"${content.slice(0, 300)}"\n\n` +
      `הצע 1-2 תגיות קצרות ורלוונטיות בעברית (מילה אחת כל אחת).\n` +
      `החזר JSON בלבד: ["תגית1", "תגית2"]\n` +
      `תגיות אפשריות: עבודה, קוד, רעיון, אישי, פגישה, למידה, בריאות, פרויקט, טיפ, קישור`
    );
    const raw     = result.response.text().trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    const tags    = JSON.parse(raw);
    return Array.isArray(tags) ? tags.slice(0, 2).map((t) => String(t).trim()) : [];
  } catch {
    return [];
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function addNote(content) {
  const notes = load();
  // Extract title: first line, max 50 chars
  const title = content.split('\n')[0].slice(0, 50);
  const tags  = await suggestTags(content);

  const note = {
    id:        nextId(notes),
    title,
    content,
    tags,
    createdAt: new Date().toISOString(),
  };
  notes.push(note);
  save(notes);
  return note;
}

function deleteNote(id) {
  const notes = load();
  const idx   = notes.findIndex((n) => n.id === id);
  if (idx === -1) return false;
  notes.splice(idx, 1);
  save(notes);
  return true;
}

function searchNotes(keyword) {
  const kw = keyword.toLowerCase();
  return load().filter(
    (n) => n.title.toLowerCase().includes(kw) ||
           n.content.toLowerCase().includes(kw) ||
           n.tags.some((t) => t.toLowerCase().includes(kw))
  );
}

function getNotesByTag(tag) {
  const t = tag.toLowerCase();
  return load().filter((n) => n.tags.some((nt) => nt.toLowerCase().includes(t)));
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtNote(n, showFull = false) {
  const tags = n.tags.length ? ` 🏷️ ${n.tags.join(', ')}` : '';
  const body = showFull ? `\n${n.content}` : '';
  return `📝 <b>#${n.id}</b> ${n.title}${tags}\n<i>${fmtDate(n.createdAt)}</i>${body}`;
}

function formatList(notes, header = '') {
  if (!notes.length) return header + '📭 אין הערות.';
  return (header ? header + '\n\n' : '') + notes.map((n) => fmtNote(n)).join('\n\n') +
    '\n\n<i>/note search [מילה] | /note tag [תגית] | /delnote [ID]</i>';
}

module.exports = { addNote, deleteNote, searchNotes, getNotesByTag, formatList, load, fmtNote };
