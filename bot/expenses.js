'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const FILE = path.join(__dirname, '..', 'data', 'expenses.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Save a full invoice/expense record.
 */
function saveInvoice(fields) {
  const expenses = load();
  const entry = {
    id:          expenses.length ? Math.max(...expenses.map(e => e.id)) + 1 : 1,
    date:        fields.date         || new Date().toISOString().split('T')[0],
    vendor:      fields.vendor       || fields.store || null,
    amount:      fields.amount != null ? parseFloat(String(fields.amount).replace(/[^0-9.]/g, '')) || null : null,
    currency:    fields.currency     || 'ILS',
    category:    fields.category     || 'other',
    source:      fields.source       || 'manual',
    emailId:     fields.emailId      || null,
    description: fields.description  || fields.extractedText || null,
    month:       fields.month        || (fields.date ? fields.date.slice(0, 7) : currentMonth()),
    savedAt:     new Date().toISOString(),
  };
  expenses.push(entry);
  save(expenses);
  return entry;
}

/**
 * Backward-compatible wrapper used by telegram.js OCR path.
 */
function saveExpense(fields) {
  return saveInvoice({
    vendor:      fields.store,
    amount:      fields.amount,
    date:        fields.date,
    description: fields.extractedText,
    source:      'photo',
  });
}

/**
 * Return all saved expenses, newest first.
 */
function getExpenses() {
  return load().reverse();
}

/**
 * Return expenses for a given month (YYYY-MM). Defaults to current month.
 */
function getMonthlyExpenses(month) {
  const m = month || currentMonth();
  return load().filter(e => (e.month || '').startsWith(m));
}

/**
 * Return a formatted Telegram summary for a month.
 */
function getExpenseSummary(month) {
  const m     = month || currentMonth();
  const items = getMonthlyExpenses(m);

  if (!items.length) return `📊 אין הוצאות רשומות לחודש ${m}`;

  // Group by currency
  const totals = {};
  const byCat  = {};
  for (const e of items) {
    const cur = e.currency || 'ILS';
    if (e.amount) {
      totals[cur] = (totals[cur] || 0) + e.amount;
      const cat = e.category || 'other';
      if (!byCat[cat]) byCat[cat] = {};
      byCat[cat][cur] = (byCat[cat][cur] || 0) + e.amount;
    }
  }

  const totalLines = Object.entries(totals)
    .map(([cur, amt]) => `${amt.toFixed(2)} ${cur}`)
    .join(' / ') || '—';

  const catEmoji = { tech: '💻', food: '🍔', health: '💊', office: '📦', other: '📌' };
  const catLines = Object.entries(byCat).map(([cat, curMap]) => {
    const vals = Object.entries(curMap).map(([cur, amt]) => `${amt.toFixed(2)} ${cur}`).join(' / ');
    return `${catEmoji[cat] || '📌'} ${cat}: ${vals}`;
  }).join('\n');

  const srcCount = { email: 0, photo: 0, manual: 0 };
  items.forEach(e => { if (srcCount[e.source] !== undefined) srcCount[e.source]++; });

  const monthName = new Date(m + '-01').toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });

  return `📊 הוצאות ${monthName}:\nסה"כ: ${totalLines}\n\n${catLines}\n\n` +
    `📧 ממייל: ${srcCount.email} | 🖼️ מתמונה: ${srcCount.photo} | ✏️ ידני: ${srcCount.manual}`;
}

/**
 * Generate a CSV file for a month, write to /tmp, return file path.
 */
function exportToCSV(month) {
  const m     = month || currentMonth();
  const items = getMonthlyExpenses(m);

  const header = 'id,date,vendor,amount,currency,category,source,description';
  const rows   = items.map(e => [
    e.id,
    e.date || '',
    `"${(e.vendor || '').replace(/"/g, '""')}"`,
    e.amount != null ? e.amount : '',
    e.currency || 'ILS',
    e.category || 'other',
    e.source || 'manual',
    `"${(e.description || '').replace(/"/g, '""').slice(0, 100)}"`,
  ].join(','));

  const csv      = [header, ...rows].join('\n');
  const filePath = path.join(os.tmpdir(), `expenses-${m}.csv`);
  fs.writeFileSync(filePath, csv, 'utf8');
  return filePath;
}

module.exports = { saveExpense, saveInvoice, getExpenses, getMonthlyExpenses, getExpenseSummary, exportToCSV };
