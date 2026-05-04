'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../skills/research');
const { subscribeTopic, getHistory } = _internals;

const ctx = { chat_id: 758752313 };

test('subscribeTopic rejects empty topic', async () => {
  await assert.rejects(
    subscribeTopic({}, ctx, { topicsStore: {} }),
    /topic argument required/,
  );
});

test('subscribeTopic delegates to topicsStore.upsertTopic', async () => {
  let captured = null;
  const fakeStore = {
    async upsertTopic(chatId, topic, keywords, active) {
      captured = { chatId, topic, keywords, active };
      return { chat_id: chatId, topic, keywords, active };
    },
  };
  const out = await subscribeTopic(
    { topic: 'ketamine', keywords: ['ketamine'], active: true },
    ctx,
    { topicsStore: fakeStore },
  );
  assert.deepEqual(captured, { chatId: 758752313, topic: 'ketamine', keywords: ['ketamine'], active: true });
  assert.deepEqual(out, { ok: true, topic: 'ketamine', active: true, keywords: ['ketamine'] });
});

test('subscribeTopic defaults active=true when omitted', async () => {
  let activeArg;
  await subscribeTopic({ topic: 'X' }, ctx, {
    topicsStore: {
      async upsertTopic(_c, t, k, a) { activeArg = a; return { chat_id: 1, topic: t, keywords: k, active: a }; },
    },
  });
  assert.equal(activeArg, true);
});

test('subscribeTopic respects active=false', async () => {
  let activeArg;
  await subscribeTopic({ topic: 'X', active: false }, ctx, {
    topicsStore: {
      async upsertTopic(_c, t, k, a) { activeArg = a; return { chat_id: 1, topic: t, keywords: k, active: a }; },
    },
  });
  assert.equal(activeArg, false);
});

test('subscribeTopic non-array keywords coerce to []', async () => {
  let kwArg;
  await subscribeTopic({ topic: 'X', keywords: 'not-an-array' }, ctx, {
    topicsStore: {
      async upsertTopic(_c, t, k, a) { kwArg = k; return { chat_id: 1, topic: t, keywords: k, active: a }; },
    },
  });
  assert.deepEqual(kwArg, []);
});

test('getHistory returns articles scoped to chat_id', async () => {
  const rows = [
    { tier: 1, title: 't1', url: 'u1', source: 'pubmed', surfaced_at: '2026-04-01T00:00:00Z' },
    { tier: 2, title: 't2', url: 'u2', source: 'medrxiv', surfaced_at: '2026-04-02T00:00:00Z' },
  ];
  let chatIdArg, limitArg;
  const fakeStore = {
    async getHistory(chatId, limit) { chatIdArg = chatId; limitArg = limit; return rows; },
  };
  const out = await getHistory({}, ctx, { articlesStore: fakeStore });
  assert.equal(chatIdArg, 758752313);
  assert.equal(limitArg, 10);
  assert.equal(out.articles.length, 2);
  assert.equal(out.articles[0].url, 'u1');
});

test('getHistory respects custom limit', async () => {
  let limitArg;
  await getHistory({ limit: 25 }, ctx, {
    articlesStore: { async getHistory(_c, l) { limitArg = l; return []; } },
  });
  assert.equal(limitArg, 25);
});

test('getHistory rejects when chat_id missing', async () => {
  await assert.rejects(getHistory({}, {}, { articlesStore: {} }), /chat_id missing/);
});
