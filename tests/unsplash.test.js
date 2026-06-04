'use strict';

/**
 * #50 — Unsplash hero image helper tests.
 *
 * Pure, no-network tests on the graceful-degradation contract of
 * fetchHeroImage. We NEVER hit the live Unsplash API here.
 * Framework: node:test + node:assert/strict.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchHeroImage } = require('../bot/unsplash');

// ── export shape ──────────────────────────────────────────────────────────
test('exports fetchHeroImage as an async function', () => {
  assert.equal(typeof fetchHeroImage, 'function');
});

// ── MANDATORY fallback: no key → null, no throw, no hang ────────────────────
test('returns null when UNSPLASH_ACCESS_KEY is absent (no network)', async () => {
  const prev = process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.UNSPLASH_ACCESS_KEY;
  try {
    const result = await fetchHeroImage('coffee shop');
    assert.equal(result, null);
  } finally {
    if (prev !== undefined) process.env.UNSPLASH_ACCESS_KEY = prev;
  }
});

test('never throws on the no-key path even with odd input', async () => {
  const prev = process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.UNSPLASH_ACCESS_KEY;
  try {
    // No key short-circuits before any fetch — must resolve to null, not throw.
    await assert.doesNotReject(() => fetchHeroImage(''));
    await assert.doesNotReject(() => fetchHeroImage(undefined));
  } finally {
    if (prev !== undefined) process.env.UNSPLASH_ACCESS_KEY = prev;
  }
});

test('returns a promise (async contract)', () => {
  const prev = process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.UNSPLASH_ACCESS_KEY;
  try {
    const p = fetchHeroImage('x');
    assert.ok(p && typeof p.then === 'function');
    return p; // settle it so node:test doesn't flag a dangling promise
  } finally {
    if (prev !== undefined) process.env.UNSPLASH_ACCESS_KEY = prev;
  }
});
