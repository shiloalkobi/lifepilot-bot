'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const skill = require('../skills/research');
const { rankArticles, pickTop5, scoreOf, maybePrefixFlag, isIsraeliRecruiting,
        ISRAELI_FLAG_PREFIX, DISCLAIMER_HE } = skill._internals;

test('skill exports the right shape', () => {
  assert.equal(skill.name, 'research');
  assert.equal(typeof skill.execute, 'function');
  assert.equal(typeof skill.description, 'string');
  assert.ok(Array.isArray(skill.tools));
  assert.equal(skill.tools.length, 4);
  const names = skill.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['get_research_history', 'search_research', 'set_research_profile', 'subscribe_research_topic']);
});

test('isIsraeliRecruiting requires both flags', () => {
  assert.equal(isIsraeliRecruiting({ _meta: { israel: true,  recruiting: true  } }), true);
  assert.equal(isIsraeliRecruiting({ _meta: { israel: true,  recruiting: false } }), false);
  assert.equal(isIsraeliRecruiting({ _meta: { israel: false, recruiting: true  } }), false);
  assert.equal(isIsraeliRecruiting({}), false);
  assert.equal(isIsraeliRecruiting(null), false);
});

test('maybePrefixFlag uses title_he when present, falls back to title', () => {
  assert.equal(maybePrefixFlag({ title_he: 'כותרת', title: 'Title' }), 'כותרת');
  assert.equal(maybePrefixFlag({ title: 'Title only' }), 'Title only');
});

test('maybePrefixFlag prepends Israeli flag for recruiting trials', () => {
  const out = maybePrefixFlag({
    title: 'CRPS trial at Sheba',
    _meta: { israel: true, recruiting: true },
  });
  assert.ok(out.startsWith(ISRAELI_FLAG_PREFIX));
  assert.ok(out.endsWith('CRPS trial at Sheba'));
});

test('maybePrefixFlag does NOT prepend flag for non-recruiting Israeli trials', () => {
  const out = maybePrefixFlag({
    title: 't',
    _meta: { israel: true, recruiting: false },
  });
  assert.equal(out, 't');
});

test('scoreOf prioritizes Tier 1 over Tier 2', () => {
  const t1 = scoreOf({ tier: 1, published_at: '2026-01-01' });
  const t2 = scoreOf({ tier: 2, published_at: '2026-12-31' });
  assert.ok(t1 > t2, 'Tier 1 should always outrank Tier 2 regardless of date');
});

test('scoreOf adds Israeli boost', () => {
  const reg = scoreOf({ tier: 1 });
  const isr = scoreOf({ tier: 1, _meta: { israel: true, recruiting: true } });
  assert.ok(isr > reg);
});

test('scoreOf recency tiebreaker within same tier', () => {
  const newer = scoreOf({ tier: 1, published_at: '2026-12-31' });
  const older = scoreOf({ tier: 1, published_at: '2024-01-01' });
  assert.ok(newer > older);
});

test('rankArticles sorts descending by score', () => {
  const arts = [
    { id: 'a', tier: 2, published_at: '2026-01-01' },
    { id: 'b', tier: 1, published_at: '2026-01-01' },
    { id: 'c', tier: 1, _meta: { israel: true, recruiting: true } },
  ];
  const r = rankArticles(arts);
  assert.equal(r[0].id, 'c', 'Israeli T1 first');
  assert.equal(r[1].id, 'b', 'regular T1 second');
  assert.equal(r[2].id, 'a', 'T2 last');
});

test('pickTop5 returns 3 Tier-1 + 2 Tier-2 when available', () => {
  const ranked = [
    { id: '1', tier: 1 }, { id: '2', tier: 1 }, { id: '3', tier: 1 },
    { id: '4', tier: 1 }, { id: '5', tier: 2 }, { id: '6', tier: 2 },
    { id: '7', tier: 2 },
  ];
  const out = pickTop5(ranked);
  assert.equal(out.length, 5);
  const t1 = out.filter(a => a.tier === 1).length;
  const t2 = out.filter(a => a.tier === 2).length;
  assert.equal(t1, 3);
  assert.equal(t2, 2);
});

test('pickTop5 falls back to all Tier-1 when no Tier-2', () => {
  const ranked = [
    { id: '1', tier: 1 }, { id: '2', tier: 1 }, { id: '3', tier: 1 },
    { id: '4', tier: 1 }, { id: '5', tier: 1 },
  ];
  const out = pickTop5(ranked);
  assert.equal(out.length, 5);
  assert.equal(out.every(a => a.tier === 1), true);
});

test('pickTop5 returns fewer than 5 when nothing available', () => {
  assert.equal(pickTop5([]).length, 0);
  assert.equal(pickTop5([{ id: 'x', tier: 1 }]).length, 1);
});

test('DISCLAIMER_HE contains required Hebrew clauses (per AC06.2)', () => {
  assert.match(DISCLAIMER_HE, /אינו ייעוץ רפואי|לא ייעוץ רפואי/);
  assert.match(DISCLAIMER_HE, /הצוות הרפואי/);
});

test('classifyWithRetry retries on transport error and succeeds', async () => {
  const { classifyWithRetry } = skill._internals;
  let calls = 0;
  const mockClassify = async () => {
    calls++;
    if (calls === 1) throw new Error('transport: ECONNRESET');
    return { tier: 1, framing_he: null, block_reason: null, classifier_rationale: 'ok', blocked_by: null };
  };
  const out = await classifyWithRetry(mockClassify, {}, {});
  assert.equal(calls, 2);
  assert.equal(out.tier, 1);
});
