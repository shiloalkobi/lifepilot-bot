'use strict';

/**
 * CRPS-13 — Tier 3 Audit Dashboard tests (per docs/research/01i §5.2 + §5.3).
 *
 * Pure-builder + helper tests on fixture rows + a _internals presence check.
 * Framework: node:test + node:assert/strict. No live Supabase, no live Telegram.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAuditMessage, _internals } = require('../bot/research-audit');
const { normalizeReason, REASON_MAP, REASON_FALLBACK, groupByReason, escapeHtml } = _internals;

// Deterministic injected formatter so date rendering is test-stable and the
// builder does not depend on the host timezone.
const fmtStub = () => '30/05';
const opts = (extra = {}) => ({ ...extra, deps: { formatTimeIL: fmtStub } });

// ── §5 internals presence ────────────────────────────────────────────────────
test('research-audit exposes its _internals seams', () => {
  assert.equal(typeof normalizeReason, 'function');
  assert.equal(typeof groupByReason, 'function');
  assert.equal(typeof escapeHtml, 'function');
  assert.equal(typeof REASON_MAP, 'object');
  assert.equal(typeof REASON_FALLBACK, 'string');
});

// ── §5.2 normalizeReason ─────────────────────────────────────────────────────
test('normalizeReason — each known bucket maps to its Hebrew label', () => {
  assert.equal(normalizeReason('side_effects_unsolicited'), 'תופעות לוואי לא רלוונטיות');
  assert.equal(normalizeReason('prognosis_pessimism'), 'פסימיות פרוגנוסטית');
  assert.equal(normalizeReason('irrelevant_topic'), 'לא רלוונטי ל-CRPS');
  assert.equal(normalizeReason('mortality_stats'), 'סטטיסטיקות תמותה');
  assert.equal(normalizeReason('graphic_procedure_description'), 'תיאור גרפי');
  assert.equal(normalizeReason('misleading_content'), 'תוכן מטעה');
});

test('normalizeReason — case-insensitive', () => {
  assert.equal(normalizeReason('PROGNOSIS_PESSIMISM'), 'פסימיות פרוגנוסטית');
  assert.equal(normalizeReason('prognosis_pessimism'), 'פסימיות פרוגנוסטית');
});

test('normalizeReason — synonym collapse to "לא רלוונטי ל-CRPS"', () => {
  for (const code of ['irrelevant_topic', 'OFF_TOPIC', 'irrelevant_content', 'irrelevant_condition']) {
    assert.equal(normalizeReason(code), 'לא רלוונטי ל-CRPS', `failed for ${code}`);
  }
});

test('normalizeReason — spaced variant "Irrelevant content" → "לא רלוונטי ל-CRPS" (space→_)', () => {
  assert.equal(normalizeReason('Irrelevant content'), 'לא רלוונטי ל-CRPS');
});

test("normalizeReason — 'unknown' (real index.js default) → fallback", () => {
  assert.equal(normalizeReason('unknown'), REASON_FALLBACK);
  assert.equal(REASON_FALLBACK, 'אחר / לא מסווג');
});

test('normalizeReason — null / undefined / "" → fallback, no throw', () => {
  assert.equal(normalizeReason(null), REASON_FALLBACK);
  assert.equal(normalizeReason(undefined), REASON_FALLBACK);
  assert.equal(normalizeReason(''), REASON_FALLBACK);
});

// ── §5.3 groupByReason ───────────────────────────────────────────────────────

// The real Phase 1 distribution of 23 rows (11/4/4/2/1/1), with the 11 spread
// across 5 synonym spellings (incl. the spaced "Irrelevant content") to prove
// the merge.
function phase1Rows() {
  const rows = [];
  const add = (n, reason_code) => {
    for (let i = 0; i < n; i++) rows.push({
      source: 'pubmed', source_id: `${reason_code}-${i}`, title: `t-${reason_code}-${i}`,
      url: 'u', blocked_at: '2026-05-30T00:00:00Z', blocked_by: 'llm_classifier',
      reason_code, classifier_rationale: 'r',
    });
  };
  // 11 irrelevant, across synonyms incl. spaced variant → must merge to one bucket
  add(3, 'irrelevant_topic');
  add(3, 'OFF_TOPIC');
  add(2, 'irrelevant_content');
  add(2, 'Irrelevant content'); // spaced — merges via space→_
  add(1, 'irrelevant_condition');
  add(4, 'side_effects_unsolicited');
  add(4, 'prognosis_pessimism');
  add(2, 'mortality_stats');
  add(1, 'graphic_procedure_description');
  add(1, 'misleading_content');
  return rows; // total 23
}

test('groupByReason — merges 11 irrelevant synonyms into one bucket', () => {
  const groups = groupByReason(phase1Rows());
  const irrelevant = groups.find(g => g.label === 'לא רלוונטי ל-CRPS');
  assert.ok(irrelevant);
  assert.equal(irrelevant.count, 11);
});

test('groupByReason — tallies the full §2 distribution and sorts desc', () => {
  const groups = groupByReason(phase1Rows());
  const map = Object.fromEntries(groups.map(g => [g.label, g.count]));
  assert.equal(map['לא רלוונטי ל-CRPS'], 11);
  assert.equal(map['תופעות לוואי לא רלוונטיות'], 4);
  assert.equal(map['פסימיות פרוגנוסטית'], 4);
  assert.equal(map['סטטיסטיקות תמותה'], 2);
  assert.equal(map['תיאור גרפי'], 1);
  assert.equal(map['תוכן מטעה'], 1);
  const counts = groups.map(g => g.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'sorted desc by count');
  assert.equal(counts.reduce((a, b) => a + b, 0), 23);
});

test('groupByReason — empty rows → []', () => {
  assert.deepEqual(groupByReason([]), []);
  assert.deepEqual(groupByReason(null), []);
});

// ── §5.3 buildAuditMessage ───────────────────────────────────────────────────
test('buildAuditMessage — header shows correct total (23)', () => {
  const msg = buildAuditMessage(phase1Rows(), opts());
  assert.match(msg, /סה"כ נחסמו: 23 מאמרים/);
});

test('buildAuditMessage — grouped summary counts match §2 distribution', () => {
  const msg = buildAuditMessage(phase1Rows(), opts());
  assert.match(msg, /• לא רלוונטי ל-CRPS — 11/);
  assert.match(msg, /• תופעות לוואי לא רלוונטיות — 4/);
  assert.match(msg, /• פסימיות פרוגנוסטית — 4/);
  assert.match(msg, /• סטטיסטיקות תמותה — 2/);
  assert.match(msg, /• תיאור גרפי — 1/);
  assert.match(msg, /• תוכן מטעה — 1/);
});

test('buildAuditMessage — includes the ⚙️/🤖 legend', () => {
  const msg = buildAuditMessage(phase1Rows(), opts());
  assert.match(msg, /⚙️ = חסימת חוק \(pre_filter\)/);
  assert.match(msg, /🤖 = חסימת AI \(llm_classifier\)/);
});

test('buildAuditMessage — honors titleLimit (only N titles rendered)', () => {
  const msg = buildAuditMessage(phase1Rows(), opts({ titleLimit: 3 }));
  assert.match(msg, /🕑 3 האחרונים:/);
  assert.match(msg, /^3\. /m);
  assert.doesNotMatch(msg, /^4\. /m);
  assert.match(msg, /…\(עוד 20\)/);
});

test('buildAuditMessage — output stays under 4096 chars on 23-row long-title fixture', () => {
  const longRows = phase1Rows().map((r, i) => ({ ...r, title: 'x'.repeat(200) + i }));
  const msg = buildAuditMessage(longRows, opts({ titleLimit: 10 }));
  assert.ok(msg.length < 4096, `length ${msg.length} should be < 4096`);
});

test('buildAuditMessage — null classifier_rationale (pre_filter) does not crash', () => {
  const rows = [{
    source: 'NewsAPI', source_id: 'x1', title: 'Best running shoes', url: 'u',
    blocked_at: '2026-05-28T00:00:00Z', blocked_by: 'pre_filter',
    reason_code: 'off_topic', classifier_rationale: null,
  }];
  const msg = buildAuditMessage(rows, opts());
  assert.match(msg, /Best running shoes/);
  assert.match(msg, /⚙️/); // pre_filter tag
});

test('buildAuditMessage — empty rows renders 0-count message, no crash', () => {
  const msg = buildAuditMessage([], opts());
  assert.match(msg, /סה"כ נחסמו: 0 מאמרים/);
  const msg2 = buildAuditMessage(null, opts());
  assert.match(msg2, /סה"כ נחסמו: 0 מאמרים/);
});

test('buildAuditMessage — HTML-escapes <, >, & in titles', () => {
  const rows = [{
    source: 'Reddit', source_id: 'evil', title: '<b>x</b> & <script>y</script>',
    url: 'u', blocked_at: '2026-05-29T00:00:00Z', blocked_by: 'llm_classifier',
    reason_code: 'misleading_content', classifier_rationale: 'r',
  }];
  const msg = buildAuditMessage(rows, opts());
  assert.match(msg, /&lt;b&gt;x&lt;\/b&gt; &amp; &lt;script&gt;/);
  assert.doesNotMatch(msg, /<b>x<\/b>/);
});

test('buildAuditMessage — renders blocked_at via the injected formatTimeIL', () => {
  const rows = [{
    source: 'pubmed', source_id: 'd1', title: 't', url: 'u',
    blocked_at: '2026-05-30T00:00:00Z', blocked_by: 'llm_classifier',
    reason_code: 'mortality_stats', classifier_rationale: 'r',
  }];
  const called = [];
  const msg = buildAuditMessage(rows, { deps: { formatTimeIL: (s) => { called.push(s); return 'FMT'; } } });
  assert.deepEqual(called, ['2026-05-30T00:00:00Z']);
  assert.match(msg, /FMT/);
});

// ── escapeHtml unit ──────────────────────────────────────────────────────────
test('escapeHtml — escapes &, <, > and tolerates null', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});
