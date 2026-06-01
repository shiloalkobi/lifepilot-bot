'use strict';

/**
 * CRPS-11 — Topic Subscriptions matcher + message builder tests.
 *
 * Per docs/research/01j §5:
 *   matchesTopic    — Hebrew keyword vs framing_he, English keyword vs title,
 *                     case-insensitivity, substring, empty/null fields, short-
 *                     keyword rejection.
 *   buildKeywordSet — label included (Q7), dedup, short-keyword filter.
 *   buildTopicsMessage — numbered list, empty state, HTML escaping, "(אין)".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchesTopic,
  buildKeywordSet,
  buildTopicsMessage,
  _internals,
} = require('../bot/research-topics');

// ── matchesTopic ──────────────────────────────────────────────────────────────

test('matchesTopic — Hebrew keyword hits framing_he', () => {
  const article = { title: 'A randomized trial', framing_he: 'מחקר על קטמין לכאב' };
  assert.equal(matchesTopic(article, ['קטמין']), true);
});

test('matchesTopic — English keyword hits title', () => {
  const article = { title: 'Ketamine infusion for CRPS', framing_he: null };
  assert.equal(matchesTopic(article, ['ketamine']), true);
});

test('matchesTopic — case-insensitive (KETAMINE keyword vs ketamine title)', () => {
  const article = { title: 'ketamine infusion', framing_he: null };
  assert.equal(matchesTopic(article, ['KETAMINE']), true);
});

test('matchesTopic — substring match (ketam matches ketamine)', () => {
  const article = { title: 'Ketamine infusion', framing_he: null };
  assert.equal(matchesTopic(article, ['ketam']), true);
});

test('matchesTopic — empty keywords → false (graceful no-op)', () => {
  const article = { title: 'Ketamine infusion', framing_he: 'קטמין' };
  assert.equal(matchesTopic(article, []), false);
});

test('matchesTopic — null article → false (no throw)', () => {
  assert.equal(matchesTopic(null, ['ketamine']), false);
});

test('matchesTopic — null title and framing_he → false (no throw)', () => {
  const article = { title: null, framing_he: null };
  assert.equal(matchesTopic(article, ['ketamine']), false);
});

test('matchesTopic — keyword shorter than MIN_KEYWORD_LEN is skipped', () => {
  // single-char keyword skipped; the haystack contains it but must not match.
  const article = { title: 'a study', framing_he: null };
  assert.equal(matchesTopic(article, ['a']), false);
  // MIN_KEYWORD_LEN is 2 — "IV" (exactly 2) must survive.
  assert.equal(_internals.MIN_KEYWORD_LEN, 2);
  const ivArticle = { title: 'IV ketamine protocol', framing_he: null };
  assert.equal(matchesTopic(ivArticle, ['iv']), true);
});

test('matchesTopic — no match returns false', () => {
  const article = { title: 'Physiotherapy outcomes', framing_he: 'פיזיותרפיה' };
  assert.equal(matchesTopic(article, ['ketamine', 'קטמין']), false);
});

test('matchesTopic — keyword must not span the title/framing boundary', () => {
  // title ends "foo", framing starts "bar"; "foobar" must NOT match across \n.
  const article = { title: 'foo', framing_he: 'bar' };
  assert.equal(matchesTopic(article, ['foobar']), false);
});

// ── buildKeywordSet ─────────────────────────────────────────────────────────

test('buildKeywordSet — includes the topic label as a keyword (Q7)', () => {
  const topics = [{ topic: 'ketamine', keywords: [] }];
  const out = buildKeywordSet(topics);
  assert.deepEqual(out, ['ketamine']);
});

test('buildKeywordSet — flattens label + keywords', () => {
  const topics = [{ topic: 'גירוי עצבי', keywords: ['DRG', 'spinal cord stimulation'] }];
  const out = buildKeywordSet(topics);
  assert.ok(out.includes('גירוי עצבי'));
  assert.ok(out.includes('drg'));
  assert.ok(out.includes('spinal cord stimulation'));
});

test('buildKeywordSet — dedups across topics + label/keyword overlap', () => {
  const topics = [
    { topic: 'ketamine', keywords: ['ketamine', 'IV'] },
    { topic: 'ketamine', keywords: ['iv'] },
  ];
  const out = buildKeywordSet(topics);
  // 'ketamine' (label == keyword) and 'iv' (case-folded) each appear once.
  assert.equal(out.filter(k => k === 'ketamine').length, 1);
  assert.equal(out.filter(k => k === 'iv').length, 1);
});

test('buildKeywordSet — drops short/empty keywords (and short labels)', () => {
  const topics = [
    { topic: 'a', keywords: ['x', '', '  ', 'crps'] }, // label 'a' and 'x' too short
  ];
  const out = buildKeywordSet(topics);
  assert.deepEqual(out, ['crps']);
});

test('buildKeywordSet — null/empty input → []', () => {
  assert.deepEqual(buildKeywordSet(null), []);
  assert.deepEqual(buildKeywordSet([]), []);
});

// ── buildTopicsMessage ──────────────────────────────────────────────────────

test('buildTopicsMessage — 0 active → empty-state text', () => {
  const out = buildTopicsMessage([]);
  assert.match(out, /אין נושאים פעילים/);
  // empty state must NOT contain the remove instruction.
  assert.doesNotMatch(out, /remove/);
});

test('buildTopicsMessage — null input → empty-state text', () => {
  const out = buildTopicsMessage(null);
  assert.match(out, /אין נושאים פעילים/);
});

test('buildTopicsMessage — N active → numbered list with header count', () => {
  const topics = [
    { topic: 'קטמין', keywords: ['ketamine', 'IV ketamine'] },
    { topic: 'גירוי עצבי', keywords: ['DRG'] },
  ];
  const out = buildTopicsMessage(topics);
  assert.match(out, /\(2\):/);
  assert.match(out, /1\. קטמין — מילים: ketamine, IV ketamine/);
  assert.match(out, /2\. גירוי עצבי — מילים: DRG/);
  assert.match(out, /\/topics remove/);
});

test('buildTopicsMessage — no-keyword row renders "(אין)"', () => {
  const topics = [{ topic: 'פיזיותרפיה', keywords: [] }];
  const out = buildTopicsMessage(topics);
  assert.match(out, /1\. פיזיותרפיה — מילים: \(אין\)/);
});

test('buildTopicsMessage — escapeHtml applied to label and keywords', () => {
  const topics = [{ topic: '<b>x&y', keywords: ['<i>z'] }];
  const out = buildTopicsMessage(topics);
  assert.match(out, /&lt;b&gt;x&amp;y/);
  assert.match(out, /&lt;i&gt;z/);
  assert.doesNotMatch(out, /<b>x/);
});

// ── _internals sanity ────────────────────────────────────────────────────────

test('normalizeText — null-safe lower-case', () => {
  assert.equal(_internals.normalizeText(null), '');
  assert.equal(_internals.normalizeText(undefined), '');
  assert.equal(_internals.normalizeText('ABC'), 'abc');
});

test('escapeHtml — escapes &, <, >', () => {
  assert.equal(_internals.escapeHtml('<a&b>'), '&lt;a&amp;b&gt;');
});
