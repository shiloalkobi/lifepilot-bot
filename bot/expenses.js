'use strict';

const fs   = require('fs');
const path = require('path');

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

/**
 * Save a receipt/expense entry.
 * @param {{ store?: string, amount?: string, date?: string, extractedText?: string, noteId?: number }} fields
 * @returns {object} saved expense
 */
function saveExpense(fields) {
  const expenses = load();
  const entry = {
    id:            expenses.length ? Math.max(...expenses.map(e => e.id)) + 1 : 1,
    store:         fields.store         || null,
    amount:        fields.amount        || null,
    date:          fields.date          || null,
    extractedText: fields.extractedText || null,
    noteId:        fields.noteId        || null,
    savedAt:       new Date().toISOString(),
  };
  expenses.push(entry);
  save(expenses);
  return entry;
}

/**
 * Return all saved expenses, newest first.
 * @returns {object[]}
 */
function getExpenses() {
  return load().reverse();
}

module.exports = { saveExpense, getExpenses };
