'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const medrxiv = require('../skills/research/sources/medrxiv');
const { isCrpsPaper, parsePaper, isoDate } = medrxiv;

const FIX_DIR = path.join(__dirname, 'fixtures', 'medrxiv');

test('adapter shape', () => {
  assert.equal(medrxiv.name, 'medrxiv');
  assert.equal(typeof medrxiv.fetch, 'function');
  assert.equal(typeof medrxiv.parseId, 'function');
  assert.equal(typeof medrxiv.healthCheck, 'function');
});

test('isoDate formats Date as YYYY-MM-DD', () => {
  assert.equal(isoDate(new Date('2026-01-09T12:34:56Z')), '2026-01-09');
  assert.equal(isoDate(new Date('2026-12-31T23:00:00Z')), '2026-12-31');
});

test('isCrpsPaper matches "Complex regional pain syndrome" (case-insensitive)', () => {
  assert.equal(isCrpsPaper({ title: 'A study on Complex Regional Pain Syndrome', abstract: '' }), true);
  assert.equal(isCrpsPaper({ title: 'a study on COMPLEX regional pain SYNDROME', abstract: '' }), true);
});

test('isCrpsPaper matches "CRPS" as a word', () => {
  assert.equal(isCrpsPaper({ title: 'CRPS treatment review', abstract: '' }), true);
  assert.equal(isCrpsPaper({ title: 'crpsy nothing', abstract: '' }), false);
});

test('isCrpsPaper matches "causalgia"', () => {
  assert.equal(isCrpsPaper({ title: 'Post-traumatic causalgia', abstract: '' }), true);
});

test('isCrpsPaper rejects unrelated papers', () => {
  assert.equal(isCrpsPaper({ title: 'COVID-19 mechanisms', abstract: 'unrelated content' }), false);
});

test('isCrpsPaper checks abstract too', () => {
  assert.equal(isCrpsPaper({
    title: 'Generic chronic pain study',
    abstract: 'Includes patients with reflex sympathetic dystrophy',
  }), true);
});

test('parsePaper builds correct article shape', () => {
  const a = parsePaper({
    doi: '10.1101/2025.01.01.12345678',
    title: ' CRPS preprint ',
    authors: 'Smith, J.; Jones, A.; ',
    abstract: 'Some abstract.',
    date: '2025-01-15',
    version: '2',
  });
  assert.deepEqual(a, {
    source:       'medrxiv',
    source_id:    '10.1101/2025.01.01.12345678',
    title:        'CRPS preprint',
    abstract:     'Some abstract.',
    url:          'https://www.medrxiv.org/content/10.1101/2025.01.01.12345678v2',
    authors:      ['Smith, J.', 'Jones, A.'],
    published_at: '2025-01-15',
  });
});

test('parsePaper defaults version to 1', () => {
  const a = parsePaper({
    doi: '10.1101/x',
    title: 't',
    authors: '',
  });
  assert.match(a.url, /v1$/);
});

test('parsePaper returns null on missing doi or title', () => {
  assert.equal(parsePaper({ title: 't' }), null);
  assert.equal(parsePaper({ doi: '10.1101/x' }), null);
  assert.equal(parsePaper(null), null);
});

test('fetchImpl filters fixture collection to CRPS-only papers (mocked fetch)', async (t) => {
  // Build a fake page using a few entries from the live fixture (which contains
  // mostly non-CRPS papers — we add a synthetic CRPS one to verify filter).
  const original = globalThis.fetch;
  const realPage = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'details.json'), 'utf8'));
  const fakeCrps = {
    doi: '10.1101/2025.04.01.99999999',
    title: 'New CRPS biomarker found',
    abstract: 'Complex regional pain syndrome insights.',
    authors: 'Lab, X.',
    date: '2025-04-15',
    version: '1',
  };
  const merged = {
    messages: [{ count: 3 }],
    collection: [
      ...realPage.collection.slice(0, 2),  // 2 unrelated papers
      fakeCrps,                            // 1 CRPS paper
    ],
  };
  globalThis.fetch = async () => new Response(JSON.stringify(merged), { status: 200 });
  t.after(() => { globalThis.fetch = original; });

  const out = await medrxiv.fetch(null, new Date('2025-04-01'));
  assert.equal(out.length, 1);
  assert.equal(out[0].source_id, '10.1101/2025.04.01.99999999');
});

test('fetchImpl applies user query as additional filter', async (t) => {
  const original = globalThis.fetch;
  const collection = [
    { doi: 'x1', title: 'CRPS ketamine study', authors: '', abstract: 'about ketamine', date: '2025-01-01' },
    { doi: 'x2', title: 'CRPS DRG study',      authors: '', abstract: 'about DRG',      date: '2025-01-02' },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ count: 2 }], collection }), { status: 200 });
  t.after(() => { globalThis.fetch = original; });

  const out = await medrxiv.fetch('ketamine', new Date('2025-01-01'));
  assert.equal(out.length, 1);
  assert.equal(out[0].source_id, 'x1');
});

test('fetchImpl throws on HTTP error', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(medrxiv.fetch(null, new Date()), /HTTP 503/);
});

test('parseId returns source_id', () => {
  assert.equal(medrxiv.parseId({ source_id: '10.1101/x' }), '10.1101/x');
});
