'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const topics = require('../skills/research/storage/topics');

function mockClient(routes) {
  const calls = [];
  return {
    _calls: calls,
    from(table) {
      const ops = [['from', table]];
      const route = routes[table] || {};
      const proxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve) => {
              calls.push({ table, ops });
              const last = ops[ops.length - 1][0];
              resolve(route[last] || route._default || { data: null, error: null });
            };
          }
          return (...args) => { ops.push([prop, ...args]); return proxy; };
        },
      });
      return proxy;
    },
  };
}

test('upsertTopic happy path', async () => {
  const expected = { chat_id: 1, topic: 'ketamine', keywords: ['ketamine', 'IV'], active: true };
  const client = mockClient({ research_topics: { single: { data: expected, error: null } } });
  const out = await topics.upsertTopic(1, 'ketamine', ['ketamine', 'IV'], true, client);
  assert.deepEqual(out, expected);
});

test('upsertTopic rejects empty topic', async () => {
  const client = mockClient({ research_topics: { single: { data: null, error: null } } });
  await assert.rejects(topics.upsertTopic(1, '   ', [], true, client), /non-empty string/);
});

test('upsertTopic trims topic and keywords', async () => {
  let upsertedRow = null;
  const calls = [];
  const client = {
    from(_table) {
      const ops = [];
      const proxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve) => {
              calls.push(ops);
              resolve({ data: upsertedRow, error: null });
            };
          }
          return (...args) => {
            ops.push([prop, ...args]);
            if (prop === 'upsert') upsertedRow = args[0];
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
  await topics.upsertTopic(1, '  ketamine  ', [' IV ', '', 'pump '], true, client);
  assert.equal(upsertedRow.topic, 'ketamine');
  assert.deepEqual(upsertedRow.keywords, ['IV', 'pump']);
});

test('getActiveByChatId returns rows', async () => {
  const rows = [{ topic: 'ketamine' }, { topic: 'DRG' }];
  const client = mockClient({ research_topics: { _default: { data: rows, error: null } } });
  const out = await topics.getActiveByChatId(123, client);
  assert.equal(out.length, 2);
});

test('getActiveByChatId returns [] on no rows', async () => {
  const client = mockClient({ research_topics: { _default: { data: null, error: null } } });
  const out = await topics.getActiveByChatId(123, client);
  assert.deepEqual(out, []);
});

test('deactivate succeeds on no error', async () => {
  const client = mockClient({ research_topics: { _default: { data: null, error: null } } });
  await topics.deactivate(123, 'ketamine', client);
});

test('deactivate throws on error', async () => {
  const client = mockClient({ research_topics: { _default: { data: null, error: { message: 'oops' } } } });
  await assert.rejects(topics.deactivate(123, 'ketamine', client), /deactivate failed: oops/);
});
