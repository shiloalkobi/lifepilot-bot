'use strict';

/**
 * charts.js — generates chart images via QuickChart.io (free, no key).
 * Returns a public URL that Telegram can fetch as a photo.
 */

const path = require('path');
const fs   = require('fs');
const { load: loadHealthLog } = require('./health');
const { getExpenses }         = require('./expenses');
const { getHabits }           = require('./habits');

const QC_BASE = 'https://quickchart.io/chart';
const WIDTH   = 600;
const HEIGHT  = 350;

// ── URL builder ───────────────────────────────────────────────────────────────

function chartUrl(config) {
  const json = encodeURIComponent(JSON.stringify(config));
  return `${QC_BASE}?w=${WIDTH}&h=${HEIGHT}&c=${json}`;
}

// ── Health log loader (re-export from health.js) ──────────────────────────────

function loadHealth() {
  try { return require('./health').getWeekRawStats ? require('./health') : null; } catch { return null; }
}

async function getHealthEntries(days = 7) {
  try {
    const all = await loadHealthLog();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutStr = cutoff.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    return all.filter(e => e.date >= cutStr).sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

// ── Pain Chart ────────────────────────────────────────────────────────────────

async function buildPainChartUrl(days = 7) {
  const entries = await getHealthEntries(days);
  if (!entries.length) return null;

  const labels     = entries.map(e => e.date.slice(5)); // MM-DD
  const painData   = entries.map(e => e.painLevel ?? null);
  const moodData   = entries.map(e => e.mood ?? null);

  // Point colors: red ≥7, yellow 4–6, green ≤3
  const painColors = painData.map(v =>
    v === null ? 'gray' : v >= 7 ? '#e74c3c' : v >= 4 ? '#f39c12' : '#27ae60'
  );

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label:           'כאב',
          data:            painData,
          borderColor:     '#e74c3c',
          backgroundColor: 'rgba(231,76,60,0.1)',
          pointBackgroundColor: painColors,
          pointRadius:     5,
          tension:         0.3,
          fill:            true,
        },
        {
          label:           'מצב רוח',
          data:            moodData,
          borderColor:     '#3498db',
          backgroundColor: 'rgba(52,152,219,0.08)',
          pointRadius:     4,
          tension:         0.3,
          fill:            false,
        },
      ],
    },
    options: {
      plugins: {
        title:  { display: true, text: `גרף כאב ומצב רוח — ${days} ימים` },
        legend: { position: 'bottom' },
      },
      scales: {
        y: { min: 0, max: 10, title: { display: true, text: 'רמה (1-10)' } },
        x: { title: { display: true, text: 'תאריך' } },
      },
    },
  };

  return chartUrl(config);
}

// ── Expense Chart ─────────────────────────────────────────────────────────────

async function buildExpenseChartUrl(month = null) {
  const targetMonth = month || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
  const exps = await getExpenses();
  const all = exps.filter(e => (e.date || '').startsWith(targetMonth) || (e.month || '') === targetMonth);

  if (!all.length) return null;

  // Group by category
  const catTotals = {};
  for (const e of all) {
    const cat = e.category || 'other';
    const amt = parseFloat(e.amount) || 0;
    const cur = (e.currency || 'ILS').toUpperCase();
    const key = `${cat} (${cur})`;
    catTotals[key] = (catTotals[key] || 0) + amt;
  }

  const labels = Object.keys(catTotals);
  const values = Object.values(catTotals).map(v => Math.round(v * 100) / 100);
  const COLORS  = ['#3498db','#e74c3c','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22'];

  const config = {
    type: 'pie',
    data: {
      labels,
      datasets: [{
        data:            values,
        backgroundColor: COLORS.slice(0, labels.length),
      }],
    },
    options: {
      plugins: {
        title:  { display: true, text: `הוצאות ${targetMonth}` },
        legend: { position: 'right' },
      },
    },
  };

  return chartUrl(config);
}

// ── Habit Streak Chart ────────────────────────────────────────────────────────

async function buildHabitChartUrl() {
  const habits = await getHabits();
  if (!habits.length) return null;

  const labels = habits.map(h => `${h.icon} ${h.name}`);
  const data   = habits.map(h => h.streak || 0);

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label:           'ימי רצף 🔥',
        data,
        backgroundColor: data.map(v => v >= 7 ? '#27ae60' : v >= 3 ? '#f39c12' : '#3498db'),
        borderRadius:    4,
      }],
    },
    options: {
      plugins: {
        title:  { display: true, text: 'רצף הרגלים' },
        legend: { display: false },
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'ימים' } },
      },
    },
  };

  return chartUrl(config);
}

module.exports = { buildPainChartUrl, buildExpenseChartUrl, buildHabitChartUrl };
