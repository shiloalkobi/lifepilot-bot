'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyPreFilter, RULES } = require('../skills/research/filter/keywords');

test('RULES contains exactly 15 approved entries (per 01b §6.2)', () => {
  assert.equal(RULES.length, 15);
});

test('RULES has 12 distinct reason_codes', () => {
  const codes = new Set(RULES.map(r => r.reason_code));
  assert.equal(codes.size, 12);
});

test('applyPreFilter returns { blocked: false } on empty article', () => {
  assert.deepEqual(applyPreFilter({}), { blocked: false });
  assert.deepEqual(applyPreFilter({ title: '' }), { blocked: false });
});

test('applyPreFilter does NOT block neutral CRPS articles', () => {
  const article = {
    title: 'Phase 2 RCT: low-dose naltrexone reduces CRPS pain by 38%',
    abstract: 'A randomized controlled trial of LDN in 80 patients with CRPS.',
  };
  assert.deepEqual(applyPreFilter(article), { blocked: false });
});

test('applyPreFilter does NOT false-positive on "avoiding amputation"', () => {
  // Per 01b R9 — the keyword is "amputation rate" (phrase), not bare "amputation".
  const article = {
    title: 'New treatment may help avoid amputation in severe cases',
    abstract: 'Outcomes data on avoiding amputation through neridronate therapy.',
  };
  assert.deepEqual(applyPreFilter(article), { blocked: false });
});

// One fixture per RULE row (15 total) — verifies that every approved keyword
// triggers a pre-filter block with the right reason_code.
const FIXTURES = [
  { row:  1, expect: 'suicide_keyword',       title: 'Suicide patterns in chronic pain populations',                abstract: '' },
  { row:  2, expect: 'suicide_keyword',       title: 'Suicidal ideation among chronic-pain patients — review',      abstract: '' },
  { row:  3, expect: 'selfharm_keyword',      title: 'Self-harm and chronic pain: a clinical overview',             abstract: '' },
  { row:  4, expect: 'disability_stat',       title: 'Disability rate in long-term CRPS — 10-year data',            abstract: '' },
  { row:  5, expect: 'mortality_stat',        title: 'Mortality rate in CRPS — population study',                   abstract: '' },
  { row:  6, expect: 'extreme_framing',       title: 'CRPS: the most painful condition known to medicine',          abstract: '' },
  { row:  7, expect: 'extreme_framing',       title: 'CRPS — worst pain known to humankind',                        abstract: '' },
  { row:  8, expect: 'amputation_stat',       title: 'Amputation rates after refractory CRPS',                      abstract: '' },
  { row:  9, expect: 'progression_pessimism', title: 'Progressive disability trajectory in CRPS',                   abstract: '' },
  { row: 10, expect: 'terminal_framing',      title: 'Terminal stages of refractory chronic pain',                  abstract: '' },
  { row: 11, expect: 'hopeless_framing',      title: 'Hopelessness in long-standing CRPS',                          abstract: '' },
  { row: 12, expect: 'irreversible_framing',  title: 'Irreversible damage in late-stage CRPS',                      abstract: '' },
  { row: 13, expect: 'nihilism_framing',      title: 'Why nothing works for some CRPS patients',                    abstract: '' },
  { row: 14, expect: 'forum_anecdote',        title: 'A common thread on r/CRPS',                                   abstract: 'Patients on reddit shared their experiences.' },
  { row: 15, expect: 'forum_anecdote',        title: 'Common themes in a CRPS facebook group',                      abstract: '' },
];

for (const f of FIXTURES) {
  test(`row ${f.row}: blocks "${f.title.slice(0, 40)}…" → ${f.expect}`, () => {
    const r = applyPreFilter({ title: f.title, abstract: f.abstract });
    assert.equal(r.blocked, true, `expected blocked=true, got ${JSON.stringify(r)}`);
    assert.equal(r.reason_code, f.expect);
  });
}

// Hebrew variants — at least one per category that has a Hebrew pattern.
const HEBREW_FIXTURES = [
  { expect: 'suicide_keyword',     title: 'דיון על התאבדות בקרב חולי כאב כרוני', abstract: '' },
  { expect: 'mortality_stat',      title: 'מחקר על תמותה בקרב מטופלים', abstract: '' },
  { expect: 'extreme_framing',     title: 'הכאב הנורא ביותר במחלה זו', abstract: '' },
  { expect: 'forum_anecdote',      title: 'דיון בקבוצת פייסבוק על CRPS', abstract: '' },
  { expect: 'irreversible_framing',title: 'נזק בלתי הפיך לעצב', abstract: '' },
];

for (const f of HEBREW_FIXTURES) {
  test(`Hebrew variant: blocks "${f.title}" → ${f.expect}`, () => {
    const r = applyPreFilter({ title: f.title, abstract: f.abstract });
    assert.equal(r.blocked, true, `expected blocked=true, got ${JSON.stringify(r)}`);
    assert.equal(r.reason_code, f.expect);
  });
}

test('substring "credit" does NOT match \\breddit\\b', () => {
  const r = applyPreFilter({ title: 'Credit-card fraud research (a CRPS analogy)', abstract: '' });
  assert.equal(r.blocked, false);
});
