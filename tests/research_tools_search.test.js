'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../skills/research');
const { searchResearch } = _internals;

// Build a complete dependency-injection bundle for searchResearch.
function makeDeps({
  cacheRows = [],
  fetched = [],
  classifyOf = (a) => ({ tier: 1, framing_he: null, block_reason: null, classifier_rationale: 'ok', blocked_by: null }),
  upsertReturns = (a, c) => ({ ...a, id: `id-${a.source_id}`, tier: c.tier, framing_he: c.framing_he }),
  needsDisclaimer = false,
  profile = { chat_id: 758752313, treatments: [] },
}) {
  const blockedAppends = [];
  const surfaced = [];
  const upserted = [];
  return {
    blockedAppends, surfaced, upserted,
    deps: {
      adapters: [
        { name: 'pubmed',         async fetch() { return fetched.filter(a => a.source === 'pubmed'); } },
        { name: 'clinicaltrials', async fetch() { return fetched.filter(a => a.source === 'clinicaltrials'); } },
        { name: 'medrxiv',        async fetch() { return fetched.filter(a => a.source === 'medrxiv'); } },
      ],
      classifyArticle: async (article, _profile) => classifyOf(article),
      articlesStore: {
        async findFreshUnseen()    { return cacheRows; },
        async upsertArticle(a, c)  { const row = upsertReturns(a, c); upserted.push(row); return row; },
        async markSurfaced(id, _c) { surfaced.push(id); },
      },
      blockedStore: {
        async appendBlocked(entry) { blockedAppends.push(entry); return entry; },
      },
      profileStore: {
        async ensureProfile()      { return profile; },
        async getProfile()         { return profile; },
        async needsDisclaimer()    { return !!needsDisclaimer; },
        async markDisclaimerShown(){ /* no-op */ },
      },
    },
  };
}

const ctx = { chat_id: 758752313 };

test('cache-only path: 5 cached articles, no fetch needed', async () => {
  const cacheRows = [
    { id: '1', tier: 1, source: 'pubmed', source_id: 'p1', title: 'A1', framing_he: null, published_at: '2026-04-01' },
    { id: '2', tier: 1, source: 'pubmed', source_id: 'p2', title: 'A2', framing_he: null, published_at: '2026-04-02' },
    { id: '3', tier: 1, source: 'pubmed', source_id: 'p3', title: 'A3', framing_he: null, published_at: '2026-04-03' },
    { id: '4', tier: 2, source: 'pubmed', source_id: 'p4', title: 'A4', framing_he: 'מעורב', published_at: '2026-04-04' },
    { id: '5', tier: 2, source: 'pubmed', source_id: 'p5', title: 'A5', framing_he: 'מעורב', published_at: '2026-04-05' },
  ];
  const { deps, surfaced, upserted } = makeDeps({ cacheRows, fetched: [{ /* would-be-fetched, ignored */ }] });
  const out = await searchResearch({}, ctx, deps);
  assert.equal(out.ok, true);
  assert.equal(out.articles.length, 5);
  assert.equal(out.blocked_count, 0);
  assert.equal(upserted.length, 0, 'no upsert when cache covers');
  assert.equal(surfaced.length, 5);
});

test('refresh=true bypasses cache and fetches', async () => {
  const fetched = [
    { source: 'pubmed', source_id: 'p99', title: 'New', abstract: 'a', url: 'u', authors: [], published_at: '2026-05-01' },
  ];
  const { deps, upserted } = makeDeps({ cacheRows: [], fetched });
  const out = await searchResearch({ refresh: true }, ctx, deps);
  assert.equal(out.ok, true);
  assert.equal(upserted.length, 1);
});

test('classifier tier 3 result goes to blocked_log, not articles', async () => {
  const fetched = [
    { source: 'pubmed', source_id: 'p1', title: 'T1', abstract: '', url: 'u', authors: [], published_at: '2026-01-01' },
  ];
  const { deps, blockedAppends, upserted } = makeDeps({
    fetched,
    classifyOf: () => ({ tier: 3, framing_he: null, block_reason: 'tier3_anecdote', classifier_rationale: 'forum-style', blocked_by: 'llm_classifier' }),
  });
  const out = await searchResearch({ refresh: true }, ctx, deps);
  assert.equal(out.blocked_count, 1);
  assert.equal(blockedAppends.length, 1);
  assert.equal(blockedAppends[0].reason_code, 'tier3_anecdote');
  assert.equal(upserted.length, 0);
});

test('Israeli recruiting trial gets +1 ranking weight (surfaces above non-Israeli)', async () => {
  const fetched = [
    { source: 'pubmed',         source_id: 'p1', title: 'Plain T1', abstract: '', url: 'u', authors: [], published_at: '2026-04-01' },
    { source: 'clinicaltrials', source_id: 'NCT-IL', title: 'Israel trial', abstract: '', url: 'u', authors: [], published_at: '2026-04-01',
      _meta: { israel: true, recruiting: true } },
  ];
  const { deps } = makeDeps({ fetched });
  const out = await searchResearch({ refresh: true }, ctx, deps);
  // Both are tier 1 (default classifyOf); israel trial should rank first.
  assert.equal(out.articles[0].source, 'clinicaltrials');
  assert.equal(out.articles[0].israeli_recruiting, true);
  assert.match(out.articles[0].title_he, /^🇮🇱 מגייס בישראל • /);
});

test('disclaimer included on first call of day, not on subsequent', async () => {
  const { deps } = makeDeps({ cacheRows: [{ id: '1', tier: 1, source: 'pubmed', source_id: 'p1', title: 'A', published_at: '2026-04-01' }], needsDisclaimer: true });
  const out = await searchResearch({}, ctx, deps);
  assert.match(out.disclaimer_he, /אינו ייעוץ רפואי|לא ייעוץ רפואי/);

  const { deps: deps2 } = makeDeps({ cacheRows: [{ id: '1', tier: 1, source: 'pubmed', source_id: 'p1', title: 'A', published_at: '2026-04-01' }], needsDisclaimer: false });
  const out2 = await searchResearch({}, ctx, deps2);
  assert.equal(out2.disclaimer_he, null);
});

test('classifier transport error is retried once before giving up', async () => {
  const fetched = [
    { source: 'pubmed', source_id: 'p1', title: 't1', abstract: '', url: 'u', authors: [], published_at: '2026-01-01' },
  ];
  let calls = 0;
  const { deps, upserted } = makeDeps({
    fetched,
    classifyOf: () => {
      calls++;
      if (calls === 1) throw new Error('transport: timeout');
      return { tier: 1, framing_he: null, block_reason: null, classifier_rationale: 'ok', blocked_by: null };
    },
  });
  const out = await searchResearch({ refresh: true }, ctx, deps);
  assert.equal(calls, 2);
  assert.equal(upserted.length, 1, 'persisted after retry succeeded');
  assert.equal(out.articles.length, 1);
});

test('classifier transport error twice → article skipped, no crash', async () => {
  const fetched = [
    { source: 'pubmed', source_id: 'p1', title: 't1', abstract: '', url: 'u', authors: [], published_at: '2026-01-01' },
  ];
  const { deps, upserted } = makeDeps({
    fetched,
    classifyOf: () => { throw new Error('transport: persistent'); },
  });
  const out = await searchResearch({ refresh: true }, ctx, deps);
  assert.equal(upserted.length, 0);
  assert.equal(out.articles.length, 0);
  assert.equal(out.ok, true);
});

test('throws when chat_id missing', async () => {
  const { deps } = makeDeps({});
  await assert.rejects(searchResearch({}, {}, deps), /chat_id missing/);
});

test('top-5 mix: 3 Tier-1 + 2 Tier-2 (Q1)', async () => {
  const fetched = [];
  const cacheRows = [
    { id: 'a', tier: 1, source: 'pubmed', source_id: 'a', title: 'T1-A', published_at: '2026-04-01' },
    { id: 'b', tier: 1, source: 'pubmed', source_id: 'b', title: 'T1-B', published_at: '2026-04-02' },
    { id: 'c', tier: 1, source: 'pubmed', source_id: 'c', title: 'T1-C', published_at: '2026-04-03' },
    { id: 'd', tier: 1, source: 'pubmed', source_id: 'd', title: 'T1-D', published_at: '2026-04-04' },
    { id: 'e', tier: 2, source: 'pubmed', source_id: 'e', title: 'T2-E', framing_he: 'מעורב', published_at: '2026-04-05' },
    { id: 'f', tier: 2, source: 'pubmed', source_id: 'f', title: 'T2-F', framing_he: 'מעורב', published_at: '2026-04-06' },
  ];
  const { deps } = makeDeps({ cacheRows, fetched });
  const out = await searchResearch({}, ctx, deps);
  assert.equal(out.articles.length, 5);
  const t1 = out.articles.filter(a => a.tier === 1).length;
  const t2 = out.articles.filter(a => a.tier === 2).length;
  assert.equal(t1, 3);
  assert.equal(t2, 2);
});
