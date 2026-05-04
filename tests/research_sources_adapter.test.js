'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertAdapter } = require('../skills/research/sources/_adapter');

test('assertAdapter accepts a valid adapter', () => {
  const valid = {
    name: 'x',
    fetch: async () => [],
    parseId: a => a.source_id,
    rateLimit: { requestsPerSecond: 1, burst: 1 },
    healthCheck: async () => true,
  };
  assert.doesNotThrow(() => assertAdapter(valid));
});

test('assertAdapter rejects null', () => {
  assert.throws(() => assertAdapter(null), /must be a non-null object/);
});

test('assertAdapter rejects missing name', () => {
  assert.throws(() => assertAdapter({
    fetch: async () => [], parseId: () => '', rateLimit: { requestsPerSecond: 1, burst: 1 }, healthCheck: async () => true,
  }), /adapter\.name/);
});

test('assertAdapter rejects non-function fetch', () => {
  assert.throws(() => assertAdapter({
    name: 'x', fetch: 'nope', parseId: () => '', rateLimit: { requestsPerSecond: 1, burst: 1 }, healthCheck: async () => true,
  }), /adapter\.fetch/);
});

test('assertAdapter rejects rateLimit without numeric fields', () => {
  assert.throws(() => assertAdapter({
    name: 'x', fetch: async () => [], parseId: () => '', rateLimit: { requestsPerSecond: '1', burst: 1 }, healthCheck: async () => true,
  }), /requestsPerSecond and burst/);
});

test('assertAdapter rejects non-positive rateLimit', () => {
  assert.throws(() => assertAdapter({
    name: 'x', fetch: async () => [], parseId: () => '', rateLimit: { requestsPerSecond: 0, burst: 1 }, healthCheck: async () => true,
  }), /must be positive/);
});

test('assertAdapter rejects missing healthCheck', () => {
  assert.throws(() => assertAdapter({
    name: 'x', fetch: async () => [], parseId: () => '', rateLimit: { requestsPerSecond: 1, burst: 1 },
  }), /adapter\.healthCheck/);
});
