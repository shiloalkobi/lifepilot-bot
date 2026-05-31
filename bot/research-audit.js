'use strict';

/**
 * CRPS-13 — Tier 3 Audit Dashboard message builder.
 *
 * Owner-only /blocked command surfaces the rows the "Hope Filter" blocked
 * (research_blocked_log), grouped by reason, so Shilo can spot over- or
 * under-blocking. Pure transparency — zero behavior change to the filter.
 *
 * STOP-list discipline (per docs/research/01i §4), mirroring research-digest.js:
 *   - Zero modification to the Hope Filter (classifier.js / keywords.js / tiers.js).
 *   - Zero modification to the appendBlocked call site (skills/research/index.js).
 *   - Zero modification to bot/telegram.js /research handler (the /blocked
 *     handler is a NEW handler, separate code path).
 *   - Zero modification to bot/research-digest.js or articles.js.
 *
 * This module owns ONLY the pure message builder + its display-time helpers.
 * The read (listBlocked) lives in skills/research/storage/blocked-log.js; the
 * owner-gate + send live in bot/telegram.js. telegram.js just requires + calls.
 */

const { formatTimeIL } = require('./reminders');

// ── reason_code normalization (DISPLAY ONLY — never mutates stored rows) ──────
// Maps normalized(reason_code) -> Hebrew bucket label. Keys are pre-normalized
// (lower-cased, whitespace→underscore) so lookup is exact. Counts in comments
// are the real Phase 1 distribution across the 23 rows.
const REASON_MAP = {
  // → "תופעות לוואי לא רלוונטיות" (4)
  side_effects_unsolicited:      'תופעות לוואי לא רלוונטיות',

  // → "פסימיות פרוגנוסטית" (4)  [catches PROGNOSIS_PESSIMISM via toLowerCase]
  prognosis_pessimism:           'פסימיות פרוגנוסטית',

  // → "לא רלוונטי ל-CRPS" (11, across 4 synonym spellings)
  irrelevant_topic:              'לא רלוונטי ל-CRPS',
  irrelevant_content:            'לא רלוונטי ל-CRPS', // also "Irrelevant content" (space→_)
  irrelevant_condition:          'לא רלוונטי ל-CRPS',
  off_topic:                     'לא רלוונטי ל-CRPS', // also "OFF_TOPIC"

  // → "סטטיסטיקות תמותה" (2)
  mortality_stats:               'סטטיסטיקות תמותה',

  // → "תיאור גרפי" (1)
  graphic_procedure_description: 'תיאור גרפי',

  // → "תוכן מטעה" (1)
  misleading_content:            'תוכן מטעה',
};

const REASON_FALLBACK = 'אחר / לא מסווג';

function normalizeReason(reasonCode) {
  const key = String(reasonCode || '').trim().toLowerCase().replace(/\s+/g, '_');
  return REASON_MAP[key] || REASON_FALLBACK;
}

// ── grouping ─────────────────────────────────────────────────────────────────
// Tally rows per Hebrew bucket, return [{ label, count }] sorted by count desc.
function groupByReason(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const label = normalizeReason(row && row.reason_code);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

// ── HTML escaping (titles are external/untrusted text) ───────────────────────
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── per-row tag: which layer blocked it ──────────────────────────────────────
function blockedByEmoji(blockedBy) {
  return blockedBy === 'pre_filter' ? '⚙️' : '🤖';
}

function truncateTitle(title, max = 60) {
  const t = String(title == null ? '' : title);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ── message builder (pure function over rows) ────────────────────────────────
// Mirrors buildDigestMessage's pure-builder contract. `deps.formatTimeIL`
// is injectable for tests; defaults to the project IL formatter (reminders.js).
function buildAuditMessage(rows, opts = {}) {
  const { titleLimit = 10 } = opts;
  const fmt = (opts.deps && opts.deps.formatTimeIL) || formatTimeIL;
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;

  if (total === 0) {
    return '🛡️ <b>דוח חסימות — Hope Filter</b>\nסה"כ נחסמו: 0 מאמרים\n\nאין חסימות להצגה. 🎉';
  }

  const lines = [];
  lines.push('🛡️ <b>דוח חסימות — Hope Filter</b>');
  lines.push(`סה"כ נחסמו: ${total} מאמרים`);
  lines.push('');

  // Grouped summary (always shown — bounded, the guaranteed-present part).
  lines.push('לפי סיבה:');
  for (const { label, count } of groupByReason(list)) {
    lines.push(`• ${label} — ${count}`);
  }
  lines.push('');

  // Last N titles (rows already newest-first from listBlocked).
  const shown = list.slice(0, titleLimit);
  lines.push(`🕑 ${shown.length} האחרונים:`);
  shown.forEach((row, i) => {
    const title  = escapeHtml(truncateTitle(row && row.title));
    const source = escapeHtml((row && row.source) || '—');
    const date   = (row && row.blocked_at) ? fmt(row.blocked_at) : '—';
    const bucket = normalizeReason(row && row.reason_code);
    const tag    = blockedByEmoji(row && row.blocked_by);
    lines.push(`${i + 1}. ${title} · ${source} · ${date} · ${bucket} · ${tag}`);
  });
  const remaining = total - shown.length;
  if (remaining > 0) lines.push(`…(עוד ${remaining})`);
  lines.push('');

  lines.push('⚙️ = חסימת חוק (pre_filter) · 🤖 = חסימת AI (llm_classifier)');

  return lines.join('\n');
}

module.exports = {
  buildAuditMessage,
  _internals: {
    normalizeReason,
    REASON_MAP,
    REASON_FALLBACK,
    groupByReason,
    escapeHtml,
  },
};
