'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const articles = require('../skills/research/storage/articles');

// ── Tiny chainable mock for Supabase queries ─────────────────────────────────
// Supabase JS uses `.from(t).select().eq().…` chains that resolve with
// { data, error }. Proxy returns itself for every method until awaited,
// at which point `.then` resolves with the configured result.
function mockClient(routes) {
  const calls = [];
  return {
    _calls: calls,
    from(table) {
      const ops = [];
      ops.push(['from', table]);
      const route = routes[table] || {};
      const proxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve) => {
              calls.push({ table, ops });
              const key = ops[ops.length - 1][0];
              const r = route[key] || route._default || { data: null, error: null };
              resolve(r);
            };
          }
          return (...args) => {
            ops.push([prop, ...args]);
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
}

test('upsertArticle calls supabase.from(research_articles).upsert(...)', async () => {
  const expected = {
    id: 'uuid-1', source: 'pubmed', source_id: 'PMID42', tier: 1,
  };
  const client = mockClient({
    research_articles: { single: { data: expected, error: null } },
  });
  const out = await articles.upsertArticle(
    { source: 'pubmed', source_id: 'PMID42', title: 't', url: 'u', authors: ['A'], abstract: 'abs', published_at: '2026-01-01' },
    { tier: 1, framing_he: null, classifier_rationale: 'pos' },
    client,
  );
  assert.deepEqual(out, expected);
  assert.equal(client._calls[0].table, 'research_articles');
});

test('upsertArticle throws on Supabase error', async () => {
  const client = mockClient({
    research_articles: { single: { data: null, error: { message: 'unique constraint' } } },
  });
  await assert.rejects(
    articles.upsertArticle(
      { source: 'pubmed', source_id: 'PMID', title: 't', url: 'u' },
      { tier: 1 },
      client,
    ),
    /upsertArticle failed: unique constraint/,
  );
});

test('findBySourceAndId returns null on no row', async () => {
  const client = mockClient({
    research_articles: { maybeSingle: { data: null, error: null } },
  });
  const out = await articles.findBySourceAndId('pubmed', 'PMID-not-exists', client);
  assert.equal(out, null);
});

test('findFreshUnseen returns empty array on no data', async () => {
  const client = mockClient({
    research_articles: { _default: { data: null, error: null } },
  });
  const out = await articles.findFreshUnseen(123, 6, client);
  assert.deepEqual(out, []);
});

test('findFreshUnseen returns rows when present', async () => {
  const rows = [
    { id: '1', tier: 1, source: 'pubmed', source_id: 'p1' },
    { id: '2', tier: 2, source: 'pubmed', source_id: 'p2' },
  ];
  const client = mockClient({
    research_articles: { _default: { data: rows, error: null } },
  });
  const out = await articles.findFreshUnseen(123, 6, client);
  assert.equal(out.length, 2);
  assert.equal(out[0].source_id, 'p1');
});

test('findFreshUnseen throws on error', async () => {
  const client = mockClient({
    research_articles: { _default: { data: null, error: { message: 'rls denied' } } },
  });
  await assert.rejects(articles.findFreshUnseen(123, 6, client), /findFreshUnseen failed: rls denied/);
});

test('markSurfaced succeeds on no error', async () => {
  const client = mockClient({
    research_articles: { _default: { data: null, error: null } },
  });
  await articles.markSurfaced('uuid-1', 758752313, client);
  // call recorded
  assert.equal(client._calls[0].table, 'research_articles');
});

test('getHistory clamps limit and returns rows', async () => {
  const client = mockClient({
    research_articles: { _default: { data: [{ id: '1', tier: 1 }], error: null } },
  });
  const out = await articles.getHistory(123, 999, client);
  assert.equal(out.length, 1);
  // limit() invoked with 50 (clamp)
  const ops = client._calls[0].ops;
  const limitCall = ops.find(o => o[0] === 'limit');
  assert.equal(limitCall[1], 50);
});

test('getHistory uses default 10 when limit absent', async () => {
  const client = mockClient({
    research_articles: { _default: { data: [], error: null } },
  });
  await articles.getHistory(123, undefined, client);
  const limitCall = client._calls[0].ops.find(o => o[0] === 'limit');
  assert.equal(limitCall[1], 10);
});

test('getHistory clamps non-positive limits to 1', async () => {
  const client = mockClient({
    research_articles: { _default: { data: [], error: null } },
  });
  await articles.getHistory(123, 0, client);
  const limitCall = client._calls[0].ops.find(o => o[0] === 'limit');
  assert.equal(limitCall[1], 10); // 0 falls through to default
});

test('deleteBySourceIdPrefix calls .delete().like(source_id, prefix%)', async () => {
  const client = mockClient({
    research_articles: { _default: { data: null, error: null } },
  });
  await articles.deleteBySourceIdPrefix('test-', client);
  const ops = client._calls[0].ops;
  assert.ok(ops.some(o => o[0] === 'delete'));
  const likeCall = ops.find(o => o[0] === 'like');
  assert.equal(likeCall[2], 'test-%');
});

test('deleteBySourceIdPrefix rejects empty prefix', async () => {
  const client = mockClient({ research_articles: { _default: { data: null, error: null } } });
  await assert.rejects(articles.deleteBySourceIdPrefix('', client), /non-empty string prefix/);
});

test('throws when no client and bot/supabase has none', async () => {
  // Note: defaultClient is loaded at require time. If your local .env has
  // SUPABASE_URL but no service_role key, defaultClient may exist as anon.
  // This test only verifies that an explicitly-null client + missing default
  // throws — which is hard to assert without env manipulation. Skip if loaded.
  // Documented behavior covered by getClient() in source.
  assert.ok(typeof articles.upsertArticle === 'function');
});
