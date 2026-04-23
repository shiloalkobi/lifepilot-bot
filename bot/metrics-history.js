'use strict';

const { supabase, isEnabled } = require('./supabase');

// ── In-memory cache (per chat_id, 60s TTL) ──────────────────────────────────
const historyCache = new Map(); // chatId → { data, expiresAt }
const CACHE_TTL_MS = 60 * 1000;

function getCached(chatId) {
  const entry = historyCache.get(String(chatId));
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    historyCache.delete(String(chatId));
    return null;
  }
  return entry.data;
}

function setCached(chatId, data) {
  historyCache.set(String(chatId), {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function invalidateCache(chatId) {
  if (chatId) historyCache.delete(String(chatId));
  else historyCache.clear();
}

// ── Date helpers (UTC, YYYY-MM-DD keys) ──────────────────────────────────────
function last7Days(offsetDays = 0) {
  const days = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i - offsetDays);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function dayKey(ts) {
  if (!ts) return null;
  try { return new Date(ts).toISOString().slice(0, 10); } catch { return null; }
}

function pctChange(current, previous) {
  const a = current.reduce((s, x) => s + (Number(x) || 0), 0);
  const b = previous.reduce((s, x) => s + (Number(x) || 0), 0);
  if (b === 0) return a > 0 ? 100 : 0;
  return Math.round(((a - b) / b) * 100);
}

// Accept rows with matching chat_id OR NULL (for backwards-compat during rollout)
function chatIdFilter(qb, chatId) {
  if (chatId == null) return qb;
  return qb.or(`chat_id.eq.${Number(chatId)},chat_id.is.null`);
}

// ── Per-metric aggregators ───────────────────────────────────────────────────
async function tasksHistory(chatId) {
  const sinceIso = new Date(Date.now() - 14 * 864e5).toISOString();
  let q = supabase.from('tasks').select('data, created_at').gte('created_at', sinceIso);
  q = chatIdFilter(q, chatId);
  const { data: rows, error } = await q;
  if (error) throw new Error(`tasks: ${error.message}`);

  const last7keys = last7Days();
  const prev7keys = last7Days(7);
  const last7 = last7keys.map(() => 0);
  const prev7 = prev7keys.map(() => 0);

  (rows || []).forEach(r => {
    if (!r.data?.done) return;
    const ts = r.data?.doneAt || r.data?.completed_at || r.created_at;
    const k  = dayKey(ts);
    const i  = last7keys.indexOf(k);
    const j  = prev7keys.indexOf(k);
    if (i >= 0) last7[i]++;
    else if (j >= 0) prev7[j]++;
  });
  return { last7, prev7, change: pctChange(last7, prev7) };
}

async function habitsHistory(chatId) {
  let q = supabase.from('habits').select('data');
  q = chatIdFilter(q, chatId);
  const { data: rows, error } = await q;
  if (error) throw new Error(`habits: ${error.message}`);

  const last7keys = last7Days();
  const prev7keys = last7Days(7);
  const last7 = last7keys.map(() => 0);
  const prev7 = prev7keys.map(() => 0);

  (rows || []).forEach(r => {
    const logs = r.data?.logs || [];
    logs.forEach(log => {
      // habits/logs use { date: 'YYYY-MM-DD', done: true } — not "completed"
      const isDone = log.done === true || log.completed === true;
      if (!isDone) return;
      const k = typeof log.date === 'string' ? log.date.slice(0, 10) : dayKey(log.date);
      const i = last7keys.indexOf(k);
      const j = prev7keys.indexOf(k);
      if (i >= 0) last7[i]++;
      else if (j >= 0) prev7[j]++;
    });
  });
  return { last7, prev7, change: pctChange(last7, prev7) };
}

async function expensesHistory(chatId) {
  const sinceIso = new Date(Date.now() - 14 * 864e5).toISOString();
  let q = supabase.from('expenses').select('data, created_at').gte('created_at', sinceIso);
  q = chatIdFilter(q, chatId);
  const { data: rows, error } = await q;
  if (error) throw new Error(`expenses: ${error.message}`);

  const last7keys = last7Days();
  const prev7keys = last7Days(7);
  const last7 = last7keys.map(() => 0);
  const prev7 = prev7keys.map(() => 0);

  (rows || []).forEach(r => {
    const d = r.data || {};
    // Prefer ILS-normalised amount; fall back to raw amount only if ILS.
    let amount = 0;
    if (d.amountIls != null)       amount = Number(d.amountIls);
    else if (d.amount_ils != null) amount = Number(d.amount_ils);
    else if (d.currency === 'ILS' || d.currency == null) amount = Number(d.amount) || 0;
    // USD amounts without FX are ignored (cannot mix currencies into one sparkline).

    if (!amount || isNaN(amount)) return;
    const k = dayKey(r.created_at);
    const i = last7keys.indexOf(k);
    const j = prev7keys.indexOf(k);
    if (i >= 0) last7[i] += amount;
    else if (j >= 0) prev7[j] += amount;
  });
  return {
    last7: last7.map(v => Math.round(v)),
    prev7: prev7.map(v => Math.round(v)),
    change: pctChange(last7, prev7),
  };
}

async function leadsHistory(chatId) {
  const sinceIso = new Date(Date.now() - 14 * 864e5).toISOString();
  let q = supabase.from('leads').select('created_at').gte('created_at', sinceIso);
  q = chatIdFilter(q, chatId);
  const { data: rows, error } = await q;
  if (error) throw new Error(`leads: ${error.message}`);

  const last7keys = last7Days();
  const prev7keys = last7Days(7);
  const last7 = last7keys.map(() => 0);
  const prev7 = prev7keys.map(() => 0);

  (rows || []).forEach(r => {
    const k = dayKey(r.created_at);
    const i = last7keys.indexOf(k);
    const j = prev7keys.indexOf(k);
    if (i >= 0) last7[i]++;
    else if (j >= 0) prev7[j]++;
  });
  return { last7, prev7, change: pctChange(last7, prev7) };
}

async function healthHistory(chatId) {
  const sinceIso = new Date(Date.now() - 7 * 864e5).toISOString();
  let q = supabase.from('health_logs').select('data, created_at')
    .gte('created_at', sinceIso).order('created_at', { ascending: true });
  q = chatIdFilter(q, chatId);
  const { data: rows, error } = await q;
  if (error) throw new Error(`health_logs: ${error.message}`);

  const last7keys = last7Days();
  const byDay = {};
  last7keys.forEach(k => { byDay[k] = { pain: [], mood: [], sleep: [] }; });

  (rows || []).forEach(r => {
    // health_logs.id is the date string (YYYY-MM-DD) — trust that first.
    const d = r.data || {};
    const k = (typeof d.date === 'string' && d.date.length >= 10) ? d.date.slice(0, 10) : dayKey(r.created_at);
    if (!byDay[k]) return;
    const pain  = Number(d.pain);
    const mood  = Number(d.mood);
    const sleep = Number(d.sleep);
    if (!isNaN(pain))  byDay[k].pain.push(pain);
    if (!isNaN(mood))  byDay[k].mood.push(mood);
    if (!isNaN(sleep)) byDay[k].sleep.push(sleep);
  });

  const avg = arr => arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(1) : null;
  return {
    painLast7:  last7keys.map(k => avg(byDay[k].pain)),
    moodLast7:  last7keys.map(k => avg(byDay[k].mood)),
    sleepLast7: last7keys.map(k => avg(byDay[k].sleep)),
  };
}

// ── Public entrypoint ────────────────────────────────────────────────────────
async function getMetricsHistory(chatId) {
  if (!isEnabled()) return { available: false };

  const cached = getCached(chatId);
  if (cached) return { ...cached, cached: true };

  const started = Date.now();
  try {
    const [tasks, habits, expenses, leads, health] = await Promise.all([
      tasksHistory(chatId).catch(e => ({ _err: e.message })),
      habitsHistory(chatId).catch(e => ({ _err: e.message })),
      expensesHistory(chatId).catch(e => ({ _err: e.message })),
      leadsHistory(chatId).catch(e => ({ _err: e.message })),
      healthHistory(chatId).catch(e => ({ _err: e.message })),
    ]);
    const ms = Date.now() - started;
    // Network RTT to Supabase Frankfurt is ~500-700ms; only warn on outliers
    if (ms > 1000) console.warn(`[MetricsHistory] Slow: ${ms}ms`);

    const result = { available: true, tasks, habits, expenses, leads, health, computedInMs: ms };
    setCached(chatId, result); // only successful results are cached
    return result;
  } catch (e) {
    console.warn('[MetricsHistory] error:', e.message);
    return { available: false, error: e.message }; // NOT cached
  }
}

module.exports = { getMetricsHistory, invalidateCache };
