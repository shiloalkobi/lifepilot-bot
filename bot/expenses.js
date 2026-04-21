'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { supabase, isEnabled } = require('./supabase');

const FILE = path.join(__dirname, '..', 'data', 'expenses.json');

function loadFromJson() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function saveToJson(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('[expenses] JSON save failed:', e.message);
  }
}

// Unified schema row → in-memory expense (numeric id preserved).
function rowToExpense(r) {
  const d = r.data || {};
  return {
    id:          Number(r.id),
    date:        d.date,
    vendor:      d.vendor || d.store || null,
    amount:      d.amount,
    currency:    d.currency    || 'ILS',
    category:    d.category    || 'other',
    source:      d.source      || 'manual',
    emailId:     d.email_id    || d.emailId || null,
    description: d.description || null,
    month:       d.month,
    savedAt:     r.created_at,
  };
}

async function load() {
  if (isEnabled()) {
    const { data, error } = await supabase
      .from('expenses')
      .select('*');
    if (!error && Array.isArray(data)) {
      return data.map(rowToExpense).sort((a, b) => a.id - b.id);
    }
    if (error) console.warn('[Supabase] expenses load error:', error.message);
  }
  return loadFromJson();
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function saveInvoice(fields) {
  const existing = await load();
  const entry = {
    id:          existing.length ? Math.max(...existing.map(e => e.id)) + 1 : 1,
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

  if (isEnabled()) {
    const { error } = await supabase.from('expenses').insert({
      id:         String(entry.id),
      chat_id:    null,
      data: {
        date:        entry.date,
        vendor:      entry.vendor,
        store:       entry.vendor,
        amount:      entry.amount,
        currency:    entry.currency,
        category:    entry.category,
        source:      entry.source,
        email_id:    entry.emailId,
        description: entry.description,
        month:       entry.month,
      },
      created_at: entry.savedAt,
      updated_at: entry.savedAt,
    });
    if (error) console.warn('[Supabase] saveInvoice error:', error.message);
  }

  const expenses = loadFromJson();
  expenses.push(entry);
  saveToJson(expenses);

  return entry;
}

async function saveExpense(fields) {
  return saveInvoice({
    vendor:      fields.store,
    amount:      fields.amount,
    date:        fields.date,
    description: fields.extractedText,
    source:      'photo',
  });
}

async function getExpenses() {
  const rows = await load();
  return rows.reverse();
}

async function getMonthlyExpenses(month) {
  const m = month || currentMonth();
  const rows = await load();
  return rows.filter(e => (e.month || '').startsWith(m));
}

async function getExpenseSummary(month) {
  const m     = month || currentMonth();
  const items = await getMonthlyExpenses(m);

  if (!items.length) return `📊 אין הוצאות רשומות לחודש ${m}`;

  const totals = {};
  const byCat  = {};
  for (const e of items) {
    const cur = e.currency || 'ILS';
    if (e.amount != null && e.amount > 0) {
      totals[cur] = (totals[cur] || 0) + e.amount;
      const cat = e.category || 'other';
      if (!byCat[cat]) byCat[cat] = {};
      byCat[cat][cur] = (byCat[cat][cur] || 0) + e.amount;
    }
  }

  const hasAmounts = Object.keys(totals).length > 0;
  const totalLines = hasAmounts
    ? Object.entries(totals).map(([cur, amt]) => `${amt.toFixed(2)} ${cur}`).join(' / ')
    : 'סכום לא ידוע';

  const catEmoji = { tech: '💻', food: '🍔', health: '💊', office: '📦', other: '📌' };
  let catLines = Object.entries(byCat).map(([cat, curMap]) => {
    const vals = Object.entries(curMap).map(([cur, amt]) => `${amt.toFixed(2)} ${cur}`).join(' / ');
    return `${catEmoji[cat] || '📌'} ${cat}: ${vals}`;
  }).join('\n');

  const noAmountItems = items.filter(e => !e.amount || e.amount <= 0);
  if (noAmountItems.length) {
    const noAmtList = noAmountItems.slice(0, 8).map(e => `• ${e.vendor || '?'} (סכום לא ידוע)`).join('\n');
    catLines = catLines ? `${catLines}\n\n📋 ללא סכום:\n${noAmtList}` : `📋 ללא סכום:\n${noAmtList}`;
  }

  const srcCount = { email: 0, photo: 0, manual: 0 };
  items.forEach(e => { if (srcCount[e.source] !== undefined) srcCount[e.source]++; });

  const monthName = new Date(m + '-01').toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });

  return `📊 הוצאות ${monthName} (${items.length} פריטים):\nסה"כ: ${totalLines}\n\n${catLines}\n\n` +
    `📧 ממייל: ${srcCount.email} | 🖼️ מתמונה: ${srcCount.photo} | ✏️ ידני: ${srcCount.manual}`;
}

async function exportToCSV(month) {
  const m     = month || currentMonth();
  const items = await getMonthlyExpenses(m);

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

  const ilsTotal = items
    .filter(e => (e.currency || 'ILS') === 'ILS' && e.amount)
    .reduce((sum, e) => sum + e.amount, 0);
  const usdTotal = items
    .filter(e => e.currency === 'USD' && e.amount)
    .reduce((sum, e) => sum + e.amount, 0);

  rows.push('');
  if (ilsTotal > 0) rows.push(`סה"כ ILS,${ilsTotal.toFixed(2)}`);
  if (usdTotal > 0) rows.push(`סה"כ USD,${usdTotal.toFixed(2)}`);

  const csv      = [header, ...rows].join('\n');
  const filePath = path.join(os.tmpdir(), `expenses-${m}.csv`);
  fs.writeFileSync(filePath, csv, 'utf8');
  return filePath;
}

module.exports = { saveExpense, saveInvoice, getExpenses, getMonthlyExpenses, getExpenseSummary, exportToCSV };
