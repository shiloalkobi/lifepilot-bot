'use strict';

const fs   = require('fs');
const path = require('path');

// ── Limits ────────────────────────────────────────────────────────────────────
const LIMITS = {
  app:    { daily: 500 },
  gemini: { daily: 250, warnAt: 200, switchAt: 237 },
  groq:   { daily: 100_000, warnAt: 80_000, blockAt: 95_000 }, // tokens
};

const DATA_FILE = path.join(__dirname, '..', 'data', 'rate-limit.json');

// ── In-memory state ───────────────────────────────────────────────────────────
let state = {
  date:   todayIL(),
  app:    { count: 0 },
  gemini: { requests: 0 },
  groq:   { tokens: 0 },
  alerts: { gemini80: false, groq80: false },
};

// ── Telegram alert hook (injected via setAlertFn) ─────────────────────────────
let _alertFn = null;
function setAlertFn(fn) { _alertFn = fn; }

function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadFromFile() {
  try {
    const raw   = fs.readFileSync(DATA_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (saved.date === todayIL()) {
      state = saved;
      console.log(`[RateLimiter] Loaded: Gemini ${state.gemini.requests}/${LIMITS.gemini.daily} req | Groq ${Math.round((state.groq.tokens || 0) / 1000)}K/${LIMITS.groq.daily / 1000}K tokens`);
    } else {
      console.log('[RateLimiter] New day — starting fresh');
    }
  } catch {
    // First run or file missing — start fresh
  }
}

function persist() {
  state.date = todayIL();
  fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), () => {});
}

// ── Day rollover ──────────────────────────────────────────────────────────────
function checkDay() {
  const today = todayIL();
  if (today !== state.date) {
    console.log(`[RateLimiter] Day rolled — Gemini: ${state.gemini.requests} req | Groq: ${state.groq.tokens} tokens | App: ${state.app.count}`);
    state = {
      date:   today,
      app:    { count: 0 },
      gemini: { requests: 0 },
      groq:   { tokens: 0 },
      alerts: { gemini80: false, groq80: false },
    };
    persist();
  }
}

// ── App-level (existing API — safety net) ─────────────────────────────────────
function canCall() {
  checkDay();
  return state.app.count < LIMITS.app.daily;
}

function increment() {
  checkDay();
  state.app.count++;
  persist();
}

function getUsage() {
  checkDay();
  return { used: state.app.count, limit: LIMITS.app.daily, remaining: LIMITS.app.daily - state.app.count };
}

// ── Gemini ────────────────────────────────────────────────────────────────────
function canCallGemini() {
  checkDay();
  return state.gemini.requests < LIMITS.gemini.switchAt;
}

function incrementGemini() {
  checkDay();
  state.gemini.requests++;
  const pct = state.gemini.requests / LIMITS.gemini.daily;
  if (pct >= 0.80 && !state.alerts.gemini80) {
    state.alerts.gemini80 = true;
    const msg = `⚠️ Gemini: ${state.gemini.requests}/${LIMITS.gemini.daily} קריאות (80%) — יעבור ל-Groq ב-${LIMITS.gemini.switchAt}`;
    console.warn('[RateLimit] ' + msg);
    if (_alertFn) _alertFn(msg);
  }
  persist();
}

// ── Groq ──────────────────────────────────────────────────────────────────────
function canCallGroq() {
  checkDay();
  return state.groq.tokens < LIMITS.groq.blockAt;
}

function addGroqTokens(n) {
  checkDay();
  state.groq.tokens += (n || 0);
  const pct = state.groq.tokens / LIMITS.groq.daily;
  if (pct >= 0.80 && !state.alerts.groq80) {
    state.alerts.groq80 = true;
    const msg = `⚠️ Groq: ${Math.round(state.groq.tokens / 1000)}K/${LIMITS.groq.daily / 1000}K טוקנים (80%)`;
    console.warn('[RateLimit] ' + msg);
    if (_alertFn) _alertFn(msg);
  }
  persist();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function getStats() {
  checkDay();
  return {
    date:   state.date,
    app:    { used: state.app.count,       limit: LIMITS.app.daily },
    gemini: { used: state.gemini.requests, limit: LIMITS.gemini.daily, switchAt: LIMITS.gemini.switchAt },
    groq:   { used: state.groq.tokens,     limit: LIMITS.groq.daily },
  };
}

function formatStats() {
  const s    = getStats();
  const gPct  = Math.round(s.gemini.used / s.gemini.limit * 100);
  const grPct = Math.round(s.groq.used   / s.groq.limit   * 100);
  const aPct  = Math.round(s.app.used    / s.app.limit     * 100);
  const bar   = (pct) => '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  const emoji = (pct) => pct >= 95 ? '🔴' : pct >= 80 ? '🟠' : '🟢';
  return (
    `📊 <b>Rate Limit — ${s.date}</b>\n\n` +
    `${emoji(gPct)} <b>Gemini</b>: ${bar(gPct)} ${gPct}%\n` +
    `   ${s.gemini.used} / ${s.gemini.limit} req (עובר Groq ב-${s.gemini.switchAt})\n\n` +
    `${emoji(grPct)} <b>Groq</b>: ${bar(grPct)} ${grPct}%\n` +
    `   ${Math.round(s.groq.used / 1000)}K / ${s.groq.limit / 1000}K tokens\n\n` +
    `${emoji(aPct)} <b>App</b>: ${s.app.used} / ${s.app.limit} קריאות\n` +
    `<i>מתאפס בחצות שעון ישראל</i>`
  );
}

// Keep old formatUsage as alias
function formatUsage() { return formatStats(); }

// ── Init ──────────────────────────────────────────────────────────────────────
loadFromFile();

module.exports = {
  canCall, increment, getUsage, formatUsage,
  canCallGemini, incrementGemini,
  canCallGroq, addGroqTokens,
  getStats, formatStats,
  setAlertFn,
};
