'use strict';

/**
 * CRPS-10 — Weekly Research Digest tests.
 *
 * 10 cases per docs/research/01h §5:
 *   1. buildDigestMessage — 0 unsurfaced → silent skip contract
 *   2. buildDigestMessage — exactly 5 unsurfaced
 *   3. buildDigestMessage — 8 unsurfaced (3 T1 + 5 T2), top 5 with T1 priority
 *   4. buildDigestMessage — 12 unsurfaced (all T2), still returns 5
 *   5. buildDigestMessage — Israeli-recruiting flag prefix
 *   6. sendWeeklyDigest — Shabbat overlap → no send, no surface
 *   7. sendWeeklyDigest — markSurfaced idempotency across runs
 *   8. sendWeeklyDigest — sendMessage throws → no markSurfaced
 *   9. findUnsurfaced — chat A surfaces, chat B query still returns it (storage-level)
 *  10. findUnsurfaced — Tier 3 filter (storage-level)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDigestMessage, sendWeeklyDigest, _internals } = require('../bot/research-digest');
const articlesStore = require('../skills/research/storage/articles');

const CHAT_ID = 758752313;

// ── Small store stub for digest tests ────────────────────────────────────────
function makeStoreStub({ unsurfaced = [], markSurfacedThrows = null } = {}) {
  const surfaced = [];
  return {
    surfaced,
    store: {
      async findUnsurfaced(_chatId, _limit) { return unsurfaced; },
      async markSurfaced(id, chatId) {
        if (markSurfacedThrows) throw new Error(markSurfacedThrows);
        surfaced.push({ id, chatId });
      },
    },
  };
}

function makeBotStub({ sendThrows = null } = {}) {
  const sent = [];
  return {
    sent,
    bot: {
      async sendMessage(chatId, text, opts) {
        if (sendThrows) throw new Error(sendThrows);
        sent.push({ chatId, text, opts });
      },
    },
  };
}

// ── Reuse the mockClient pattern from research_storage_articles.test.js ────
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

// ── §5.1 — 0 unsurfaced → silent-skip contract ───────────────────────────────
test('buildDigestMessage — 0 unsurfaced returns null message', async () => {
  const { store } = makeStoreStub({ unsurfaced: [] });
  const out = await buildDigestMessage(CHAT_ID, { articlesStore: store });
  assert.equal(out.message, null);
  assert.deepEqual(out.articleIds, []);
});

// ── §5.2 — exactly 5 unsurfaced ──────────────────────────────────────────────
test('buildDigestMessage — exactly 5 unsurfaced returns header + 5 items', async () => {
  const rows = [
    { id: 'a', tier: 1, title: 'T1a', framing_he: 'מסגור', url: 'u1', source: 'pubmed', published_at: '2026-04-01' },
    { id: 'b', tier: 1, title: 'T1b', framing_he: null,    url: 'u2', source: 'pubmed', published_at: '2026-04-02' },
    { id: 'c', tier: 1, title: 'T1c', framing_he: 'מעורב', url: 'u3', source: 'clinicaltrials', published_at: '2026-04-03' },
    { id: 'd', tier: 2, title: 'T2a', framing_he: null,    url: 'u4', source: 'medrxiv', published_at: '2026-04-04' },
    { id: 'e', tier: 2, title: 'T2b', framing_he: 'מעורב', url: 'u5', source: 'pubmed', published_at: '2026-04-05' },
  ];
  const { store } = makeStoreStub({ unsurfaced: rows });
  const out = await buildDigestMessage(CHAT_ID, { articlesStore: store });
  assert.ok(out.message);
  assert.match(out.message, /מצאתי 5 מאמרים חדשים/);
  assert.equal(out.articleIds.length, 5);
  // first item should be Tier 1 (rank by tier)
  assert.match(out.message, /1\. T1/);
});

// ── §5.3 — 3 T1 + 5 T2 → top 5 with T1 priority ──────────────────────────────
test('buildDigestMessage — 8 unsurfaced (3 T1 + 5 T2) returns top 5 with T1 first', async () => {
  const rows = [
    { id: 't1a', tier: 1, title: 'T1-a', url: 'u', source: 'pubmed', published_at: '2026-04-01' },
    { id: 't1b', tier: 1, title: 'T1-b', url: 'u', source: 'pubmed', published_at: '2026-04-02' },
    { id: 't1c', tier: 1, title: 'T1-c', url: 'u', source: 'pubmed', published_at: '2026-04-03' },
    { id: 't2a', tier: 2, title: 'T2-a', url: 'u', source: 'pubmed', published_at: '2026-04-04' },
    { id: 't2b', tier: 2, title: 'T2-b', url: 'u', source: 'pubmed', published_at: '2026-04-05' },
    { id: 't2c', tier: 2, title: 'T2-c', url: 'u', source: 'pubmed', published_at: '2026-04-06' },
    { id: 't2d', tier: 2, title: 'T2-d', url: 'u', source: 'pubmed', published_at: '2026-04-07' },
    { id: 't2e', tier: 2, title: 'T2-e', url: 'u', source: 'pubmed', published_at: '2026-04-08' },
  ];
  const { store } = makeStoreStub({ unsurfaced: rows });
  const out = await buildDigestMessage(CHAT_ID, { articlesStore: store });
  assert.equal(out.articleIds.length, 5);
  // exactly 3 of the surfaced ids should be Tier 1, 2 should be Tier 2
  const surfacedRows = rows.filter(r => out.articleIds.includes(r.id));
  assert.equal(surfacedRows.filter(r => r.tier === 1).length, 3);
  assert.equal(surfacedRows.filter(r => r.tier === 2).length, 2);
});

// ── §5.4 — 12 unsurfaced all T2 → still returns 5 ────────────────────────────
test('buildDigestMessage — 12 unsurfaced all Tier 2 returns 5 sorted by recency', async () => {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({
      id: `t2-${i}`, tier: 2, title: `T2-${i}`, url: 'u', source: 'pubmed',
      published_at: `2026-04-${String(i + 1).padStart(2, '0')}`,
    });
  }
  const { store } = makeStoreStub({ unsurfaced: rows });
  const out = await buildDigestMessage(CHAT_ID, { articlesStore: store });
  assert.equal(out.articleIds.length, 5);
  // All surfaced should be Tier 2 (no T1 in pool); recency tiebreaker
  // means the newest dates should win (highest day-of-month).
  const surfacedDays = out.articleIds
    .map(id => Number(id.split('-')[1]))
    .sort((a, b) => b - a);
  // Top 5 by recency = indices 11, 10, 9, 8, 7 (latest 5 dates)
  assert.deepEqual(surfacedDays, [11, 10, 9, 8, 7]);
});

// ── §5.5 — Israeli-recruiting flag prefix ────────────────────────────────────
test('buildDigestMessage — Israeli-recruiting article gets 🇮🇱 prefix', async () => {
  const rows = [
    { id: 'il', tier: 1, title: 'Ketamine Israel trial', url: 'u', source: 'clinicaltrials',
      published_at: '2026-04-01', _meta: { israel: true, recruiting: true } },
    { id: 'usa', tier: 1, title: 'Plain US trial', url: 'u', source: 'clinicaltrials',
      published_at: '2026-04-02' },
  ];
  const { store } = makeStoreStub({ unsurfaced: rows });
  const out = await buildDigestMessage(CHAT_ID, { articlesStore: store });
  // The Israeli trial should be first (Israeli-recruiting +30 bonus).
  assert.equal(out.articleIds[0], 'il');
  assert.match(out.message, /🇮🇱 מגייס בישראל • Ketamine Israel trial/);
});

// ── §5.6 — Shabbat overlap blocks send and surfacing ─────────────────────────
test('sendWeeklyDigest — Shabbat overlap returns silent skip, no send, no surface', async () => {
  const rows = [
    { id: 'a', tier: 1, title: 'Should-not-send', url: 'u', source: 'pubmed', published_at: '2026-04-01' },
  ];
  const { store, surfaced } = makeStoreStub({ unsurfaced: rows });
  const { bot, sent } = makeBotStub();
  const out = await sendWeeklyDigest(bot, CHAT_ID, {
    articlesStore: store,
    isShabbatPrecise: () => true,
  });
  assert.equal(out.sent, false);
  assert.equal(out.reason, 'shabbat');
  assert.equal(sent.length, 0);
  assert.equal(surfaced.length, 0);
});

// ── §5.7 — markSurfaced idempotency across runs (using shared in-memory pool) ──
test('sendWeeklyDigest — second run with same pool returns silent-skip', async () => {
  const pool = [
    { id: 'p1', tier: 1, title: 'T1-a', url: 'u', source: 'pubmed', published_at: '2026-04-01' },
    { id: 'p2', tier: 2, title: 'T2-a', url: 'u', source: 'pubmed', published_at: '2026-04-02' },
  ];
  const surfaced = new Set();
  const store = {
    async findUnsurfaced(chatId) {
      return pool.filter(r => !surfaced.has(`${r.id}:${chatId}`));
    },
    async markSurfaced(id, chatId) { surfaced.add(`${id}:${chatId}`); },
  };
  const { bot, sent } = makeBotStub();
  const r1 = await sendWeeklyDigest(bot, CHAT_ID, {
    articlesStore: store,
    isShabbatPrecise: () => false,
  });
  assert.equal(r1.sent, true);
  assert.equal(r1.articleIds.length, 2);
  assert.equal(sent.length, 1);

  const r2 = await sendWeeklyDigest(bot, CHAT_ID, {
    articlesStore: store,
    isShabbatPrecise: () => false,
  });
  assert.equal(r2.sent, false);
  assert.equal(r2.reason, 'empty');
  assert.equal(sent.length, 1, 'no second sendMessage');
});

// ── §5.8 — sendMessage throws → markSurfaced NOT called ──────────────────────
test('sendWeeklyDigest — bot.sendMessage throws prevents markSurfaced', async () => {
  const rows = [
    { id: 'a', tier: 1, title: 'T1-a', url: 'u', source: 'pubmed', published_at: '2026-04-01' },
  ];
  const { store, surfaced } = makeStoreStub({ unsurfaced: rows });
  const { bot } = makeBotStub({ sendThrows: 'telegram 429' });
  await assert.rejects(
    sendWeeklyDigest(bot, CHAT_ID, { articlesStore: store, isShabbatPrecise: () => false }),
    /telegram 429/,
  );
  assert.equal(surfaced.length, 0, 'backlog preserved on failed send');
});

// ── §5.9 — findUnsurfaced query shape: cross-chat visibility ─────────────────
test('findUnsurfaced — query includes surfaced_to_chat_id != chatId clause', async () => {
  const rows = [{ id: '1', tier: 1, source: 'pubmed', source_id: 'p1' }];
  const client = mockClient({
    research_articles: { _default: { data: rows, error: null } },
  });
  const out = await articlesStore.findUnsurfaced(99999, 50, client);
  assert.equal(out.length, 1);
  const ops = client._calls[0].ops;
  const orCall = ops.find(o => o[0] === 'or');
  assert.ok(orCall, '.or() should be invoked');
  assert.match(orCall[1], /surfaced_to_chat_id\.is\.null/);
  assert.match(orCall[1], /surfaced_to_chat_id\.neq\.99999/);
});

// ── §5.10 — findUnsurfaced filters to Tier 1/2 only ──────────────────────────
test('findUnsurfaced — query restricts tier to [1, 2] (Tier 3 excluded)', async () => {
  const client = mockClient({
    research_articles: { _default: { data: [], error: null } },
  });
  await articlesStore.findUnsurfaced(123, 50, client);
  const ops = client._calls[0].ops;
  const inCall = ops.find(o => o[0] === 'in');
  assert.ok(inCall, '.in() should be invoked');
  assert.equal(inCall[1], 'tier');
  assert.deepEqual(inCall[2], [1, 2]);
});

// ── Sanity: helpers are present (intentional-duplication check) ──────────────
test('research-digest duplicates ranking helpers from skills/research', () => {
  // These are the duplicated helpers — their PRESENCE on _internals
  // is the contract; behavioral equivalence with the source-of-truth
  // is covered by tests #2-#5 above (T1 priority, Israeli flag, etc).
  assert.equal(typeof _internals.rankArticles, 'function');
  assert.equal(typeof _internals.pickTop5, 'function');
  assert.equal(typeof _internals.maybePrefixFlag, 'function');
  assert.equal(typeof _internals.scoreOf, 'function');
  assert.equal(typeof _internals.isIsraeliRecruiting, 'function');
});
