'use strict';

/**
 * CRPS-11 — Topic Subscriptions message builder + matcher.
 *
 * "Finish the last mile" of research topic subscriptions: the storage CRUD
 * (skills/research/storage/topics.js) and the write tool
 * (subscribe_research_topic) already exist. This module owns the READ →
 * MATCH → SURFACE half: the pure, testable helpers that
 *   (1) render the owner-only /topics list, and
 *   (2) decide whether a digest candidate matches a subscribed topic.
 *
 * STOP-list discipline (per docs/research/01j §4), mirroring research-audit.js:
 *   - Zero modification to the Hope Filter (classifier.js / keywords.js / tiers.js).
 *   - Zero modification to skills/research/index.js (incl. the unused `topic`
 *     arg on search_research — out of MVP scope).
 *   - Zero modification to skills/research/storage/topics.js (reused as-is).
 *   - Zero modification to bot/research-audit.js / articles.js / blocked-log.js.
 *
 * This module owns ONLY pure functions. The storage reads (getActiveByChatId,
 * deactivate) live in topics.js; the owner-gate + send live in bot/telegram.js;
 * the digest boost wiring lives in bot/research-digest.js. Each of those just
 * requires + calls into the helpers here — no Telegram or Supabase coupling.
 */

// Keywords shorter than this are skipped during matching to avoid a huge
// false-match surface (e.g. "IV" is exactly 2 and must survive — Q5 → 2).
const MIN_KEYWORD_LEN = 2;

// ── normalization (MATCH-TIME ONLY — never mutates stored rows) ───────────────
// Lower-case + null-safe. JS toLowerCase is a no-op for Hebrew (no case), so
// Hebrew matching degrades to plain substring — correct for the resolved Gap.
function normalizeText(str) {
  return String(str == null ? '' : str).toLowerCase();
}

// ── HTML escaping (topic/keyword strings are user free-text) ──────────────────
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── matcher: does `article` match any subscribed keyword? ─────────────────────
// Haystack = title (English) + framing_he (Hebrew) joined with '\n' so a
// keyword can't accidentally span the field boundary. Abstract NOT scanned
// (Q4 — noisy + PHI-adjacent). Case-insensitive substring; null-safe both
// fields. Keywords below MIN_KEYWORD_LEN are skipped (Q5).
function matchesTopic(article, keywords) {
  if (!article || !Array.isArray(keywords) || keywords.length === 0) return false;
  const hay = normalizeText(article.title) + '\n' + normalizeText(article.framing_he);
  for (const kw of keywords) {
    const k = normalizeText(kw).trim();
    if (k.length < MIN_KEYWORD_LEN) continue;
    if (hay.includes(k)) return true;
  }
  return false;
}

// ── keyword set: flatten active topics into a deduped, filtered list ──────────
// Includes BOTH each row's explicit keywords[] AND its `topic` label as a
// keyword (Q7 — load-bearing: a label-only subscription with empty keywords[]
// still matches on its label). Deduped via Set; short/empty entries dropped.
function buildKeywordSet(topics) {
  const out = new Set();
  for (const r of topics || []) {
    if (r && r.topic) {
      const label = normalizeText(r.topic).trim();
      if (label) out.add(label);
    }
    const kws = r && Array.isArray(r.keywords) ? r.keywords : [];
    for (const k of kws) {
      const t = normalizeText(k).trim();
      if (t) out.add(t);
    }
  }
  return [...out].filter(k => k.length >= MIN_KEYWORD_LEN);
}

// ── message builder for /topics (pure function over rows) ─────────────────────
// `topics` are the active rows from getActiveByChatId (created_at asc). Renders
// a 1-based numbered list with each topic's original (un-normalized) label +
// keywords, plus the remove instruction. Empty state has its own copy.
function buildTopicsMessage(topics) {
  const rows = Array.isArray(topics) ? topics : [];

  if (rows.length === 0) {
    return '🎯 אין נושאים פעילים.\n\n' +
      'כדי להירשם, פשוט תכתוב לי משהו כמו "תעקוב אחרי מחקרים על קטמין".';
  }

  const lines = [];
  lines.push(`🎯 הנושאים שאתה עוקב אחריהם (${rows.length}):`);
  lines.push('');
  rows.forEach((r, i) => {
    const label = escapeHtml((r && r.topic) || '');
    const kws = r && Array.isArray(r.keywords) ? r.keywords.filter(Boolean) : [];
    const kwText = kws.length ? kws.map(escapeHtml).join(', ') : '(אין)';
    lines.push(`${i + 1}. ${label} — מילים: ${kwText}`);
  });
  lines.push('');
  lines.push('להסרה: שלח /topics remove <מספר>');

  return lines.join('\n');
}

module.exports = {
  buildTopicsMessage,
  matchesTopic,
  buildKeywordSet,
  _internals: {
    normalizeText,
    MIN_KEYWORD_LEN,
    escapeHtml,
  },
};
