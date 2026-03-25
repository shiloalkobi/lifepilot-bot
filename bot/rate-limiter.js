'use strict';

const DAILY_LIMIT = 500;

// ── State (in-memory, resets at midnight IL) ──────────────────────────────────
let count    = 0;
let resetDay = todayIL();

function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function checkDay() {
  const today = todayIL();
  if (today !== resetDay) {
    console.log(`[RateLimiter] Daily usage: ${count}/${DAILY_LIMIT} calls`);
    count    = 0;
    resetDay = today;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function canCall() {
  checkDay();
  return count < DAILY_LIMIT;
}

function increment() {
  checkDay();
  count++;
}

function getUsage() {
  checkDay();
  return { used: count, limit: DAILY_LIMIT, remaining: DAILY_LIMIT - count };
}

function formatUsage() {
  const { used, limit, remaining } = getUsage();
  const bar   = '█'.repeat(Math.round(used / limit * 10)) + '░'.repeat(10 - Math.round(used / limit * 10));
  const pct   = Math.round(used / limit * 100);
  const emoji = pct >= 90 ? '🔴' : pct >= 70 ? '🟠' : '🟢';
  return (
    `${emoji} <b>שימוש ב-API היום</b>\n\n` +
    `${bar} ${pct}%\n` +
    `📊 <b>${used} / ${limit}</b> קריאות\n` +
    `✅ נשארו: <b>${remaining}</b>\n\n` +
    `<i>מתאפס בחצות שעון ישראל</i>`
  );
}

module.exports = { canCall, increment, getUsage, formatUsage };
