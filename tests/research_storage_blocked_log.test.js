'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const blocked = require('../skills/research/storage/blocked-log');

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

test('appendBlocked happy path', async () => {
  const expected = { id: 'log-1', source: 'pubmed', source_id: 'PMID42' };
  const client = mockClient({ research_blocked_log: { single: { data: expected, error: null } } });
  const out = await blocked.appendBlocked({
    source:               'pubmed',
    source_id:            'PMID42',
    title:                'A blocked article',
    url:                  'https://pubmed.ncbi.nlm.nih.gov/42/',
    blocked_by:           'pre_filter',
    reason_code:          'suicide_keyword',
    classifier_rationale: null,
  }, client);
  assert.deepEqual(out, expected);
});

test('appendBlocked rejects missing required field', async () => {
  const client = mockClient({ research_blocked_log: { single: { data: null, error: null } } });
  await assert.rejects(
    blocked.appendBlocked({ source: 'pubmed', title: 't', blocked_by: 'pre_filter', reason_code: 'x' }, client),
    /missing required fields/,
  );
});

test('appendBlocked rejects invalid blocked_by', async () => {
  const client = mockClient({ research_blocked_log: { single: { data: null, error: null } } });
  await assert.rejects(
    blocked.appendBlocked({
      source: 'pubmed', source_id: 'p1', title: 't',
      blocked_by: 'invalid', reason_code: 'x',
    }, client),
    /invalid blocked_by/,
  );
});

test('appendBlocked accepts llm_classifier as blocked_by', async () => {
  const client = mockClient({ research_blocked_log: { single: { data: { id: '1' }, error: null } } });
  const out = await blocked.appendBlocked({
    source: 'pubmed', source_id: 'p1', title: 't',
    blocked_by: 'llm_classifier', reason_code: 'tier3_anecdote',
    classifier_rationale: 'forum-style content',
  }, client);
  assert.deepEqual(out, { id: '1' });
});

test('countSince returns the count', async () => {
  const client = {
    from: () => {
      const ops = [];
      const proxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve) => resolve({ count: 7, error: null });
          }
          return (...args) => { ops.push([prop, ...args]); return proxy; };
        },
      });
      return proxy;
    },
  };
  const out = await blocked.countSince('2026-01-01T00:00:00Z', client);
  assert.equal(out, 7);
});

test('countSince returns 0 when count is null', async () => {
  const client = {
    from: () => {
      const proxy = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve({ count: null, error: null });
          return () => proxy;
        },
      });
      return proxy;
    },
  };
  const out = await blocked.countSince('2026-01-01T00:00:00Z', client);
  assert.equal(out, 0);
});

test('deleteBySourceIdPrefix uses .like(source_id, prefix%)', async () => {
  const client = mockClient({ research_blocked_log: { _default: { data: null, error: null } } });
  await blocked.deleteBySourceIdPrefix('test-', client);
  const ops = client._calls[0].ops;
  const likeCall = ops.find(o => o[0] === 'like');
  assert.equal(likeCall[2], 'test-%');
});
