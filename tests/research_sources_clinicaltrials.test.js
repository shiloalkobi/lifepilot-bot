'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ct = require('../skills/research/sources/clinicaltrials');
const { parseStudy, studiesUrl, normalizeStartDate } = ct;

const FIX_DIR = path.join(__dirname, 'fixtures', 'clinicaltrials');

test('adapter shape', () => {
  assert.equal(ct.name, 'clinicaltrials');
  assert.equal(typeof ct.fetch, 'function');
  assert.equal(typeof ct.parseId, 'function');
  assert.equal(typeof ct.healthCheck, 'function');
});

test('studiesUrl builds correct query string', () => {
  const url = studiesUrl({
    'query.cond': 'Complex Regional Pain Syndrome',
    'query.locn': 'Israel',
    pageSize:     1,
  });
  const u = new URL(url);
  assert.equal(u.host, 'clinicaltrials.gov');
  assert.equal(u.pathname, '/api/v2/studies');
  assert.equal(u.searchParams.get('query.cond'), 'Complex Regional Pain Syndrome');
  assert.equal(u.searchParams.get('query.locn'), 'Israel');
  assert.equal(u.searchParams.get('pageSize'), '1');
});

test('parseStudy handles a complete fixture entry', () => {
  const json = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'israel.json'), 'utf8'));
  assert.ok(Array.isArray(json.studies) && json.studies.length > 0);
  const a = parseStudy(json.studies[0]);
  assert.ok(a, 'parseStudy returned a result');
  assert.equal(a.source, 'clinicaltrials');
  assert.match(a.source_id, /^NCT\d+$/);
  assert.ok(a.title && a.title.length > 0);
  assert.match(a.url, /^https:\/\/clinicaltrials\.gov\/study\/NCT\d+$/);
  assert.ok(Array.isArray(a.authors));
  assert.ok(a._meta);
  assert.equal(typeof a._meta.recruiting, 'boolean');
  assert.equal(typeof a._meta.israel, 'boolean');
});

test('parseStudy detects Israeli trials via locations.country', () => {
  const study = {
    protocolSection: {
      identificationModule: { nctId: 'NCT00000001', briefTitle: 'CRPS Test' },
      statusModule:         { overallStatus: 'RECRUITING' },
      contactsLocationsModule: {
        locations: [
          { country: 'United States' },
          { country: 'Israel' },
        ],
      },
    },
  };
  const a = parseStudy(study);
  assert.equal(a._meta.israel, true);
  assert.equal(a._meta.recruiting, true);
});

test('parseStudy returns null on missing protocolSection', () => {
  assert.equal(parseStudy({}), null);
  assert.equal(parseStudy(null), null);
});

test('parseStudy returns null on missing nctId', () => {
  assert.equal(parseStudy({
    protocolSection: { identificationModule: { briefTitle: 'no id' } },
  }), null);
});

test('parseStudy uses officialTitle fallback when briefTitle missing', () => {
  const a = parseStudy({
    protocolSection: {
      identificationModule: { nctId: 'NCT00000099', officialTitle: 'Long Title' },
      statusModule:         {},
    },
  });
  assert.equal(a.title, 'Long Title');
});

test('parseStudy populates authors from overallOfficials', () => {
  const a = parseStudy({
    protocolSection: {
      identificationModule:    { nctId: 'NCT00000002', briefTitle: 't' },
      statusModule:            {},
      contactsLocationsModule: { overallOfficials: [{ name: 'Dr. Smith' }, { name: 'Dr. Jones' }] },
    },
  });
  assert.deepEqual(a.authors, ['Dr. Smith', 'Dr. Jones']);
});

test('fetchImpl dedups studies appearing in both queries (mocked fetch)', async (t) => {
  const original = globalThis.fetch;
  const sample = (nctId) => ({
    protocolSection: {
      identificationModule: { nctId, briefTitle: `t-${nctId}` },
      statusModule:         { overallStatus: 'RECRUITING', startDateStruct: { date: '2024-01-15' } },
      contactsLocationsModule: { locations: [{ country: 'Israel' }] },
    },
  });
  let callCount = 0;
  globalThis.fetch = async (url) => {
    callCount++;
    // First call: global query — return NCT0001 + NCT0002
    // Second call: Israel query — return NCT0002 + NCT0003 (overlap on NCT0002)
    if (callCount === 1) {
      return new Response(JSON.stringify({ studies: [sample('NCT0001'), sample('NCT0002')] }), { status: 200 });
    }
    return new Response(JSON.stringify({ studies: [sample('NCT0002'), sample('NCT0003')] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });

  const out = await ct.fetch(null, null);
  assert.equal(callCount, 2);
  const ids = out.map(a => a.source_id).sort();
  assert.deepEqual(ids, ['NCT0001', 'NCT0002', 'NCT0003']);
});

test('fetchImpl throws on HTTP error', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(ct.fetch(null, null), /HTTP 500/);
});

test('parseId returns source_id', () => {
  assert.equal(ct.parseId({ source_id: 'NCT12345' }), 'NCT12345');
});

// ── Phase 4f.4 Issue #2: partial-date normalization ──────────────────────────

test('normalizeStartDate handles YYYY-MM-DD', () => {
  assert.equal(normalizeStartDate('2015-04-15'), '2015-04-15T00:00:00Z');
});

test('normalizeStartDate handles YYYY-MM (CT.gov partial — Rabin NCT01338129 shape)', () => {
  assert.equal(normalizeStartDate('2011-04'), '2011-04-01T00:00:00Z');
});

test('normalizeStartDate handles YYYY-only (placeholder shape — 2099)', () => {
  assert.equal(normalizeStartDate('2099'), '2099-01-01T00:00:00Z');
});

test('normalizeStartDate passes through full ISO timestamp unchanged', () => {
  const iso = '2020-06-15T12:34:56Z';
  assert.equal(normalizeStartDate(iso), iso);
});

test('normalizeStartDate returns null on null / non-string / garbage', () => {
  assert.equal(normalizeStartDate(null), null);
  assert.equal(normalizeStartDate(undefined), null);
  assert.equal(normalizeStartDate(''), null);
  assert.equal(normalizeStartDate(20240115), null);
  assert.equal(normalizeStartDate('not a date'), null);
  assert.equal(normalizeStartDate('2024/01/15'), null);
});

test('parseStudy with NCT01338129-shaped partial-date fixture (Rabin vitamin-C CRPS) returns normalized ISO', () => {
  // This is the exact failing trial from Shilo's smoke logs: "2011-04" caused
  // PG 22007 on upsert. After fix, parseStudy must yield a valid ISO timestamp.
  const rabin = {
    protocolSection: {
      identificationModule: {
        nctId:      'NCT01338129',
        briefTitle: 'Vitamin C for Complex Regional Pain Syndrome',
      },
      statusModule: {
        overallStatus:    'COMPLETED',
        startDateStruct:  { date: '2011-04' },
      },
      contactsLocationsModule: {
        locations: [{ country: 'Israel' }],
      },
    },
  };
  const a = parseStudy(rabin);
  assert.ok(a, 'parseStudy returned a result');
  assert.equal(a.source_id, 'NCT01338129');
  assert.equal(a.published_at, '2011-04-01T00:00:00Z');
  assert.equal(a._meta.israel, true);
});

test('fetchImpl skips studies whose date cannot be normalized (per Q2 — honest signal)', async (t) => {
  const original = globalThis.fetch;
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };

  globalThis.fetch = async () => new Response(JSON.stringify({
    studies: [
      // Valid date → should be kept
      {
        protocolSection: {
          identificationModule: { nctId: 'NCT00000001', briefTitle: 'has date' },
          statusModule:         { overallStatus: 'RECRUITING', startDateStruct: { date: '2024-06' } },
          contactsLocationsModule: { locations: [{ country: 'Israel' }] },
        },
      },
      // No date at all → should be skipped with warn
      {
        protocolSection: {
          identificationModule: { nctId: 'NCT00000002', briefTitle: 'no date' },
          statusModule:         { overallStatus: 'RECRUITING' },
          contactsLocationsModule: { locations: [{ country: 'Israel' }] },
        },
      },
    ],
  }), { status: 200 });

  t.after(() => {
    globalThis.fetch = original;
    console.warn      = originalWarn;
  });

  const out = await ct.fetch(null, null);
  const ids = out.map(a => a.source_id);
  assert.ok(ids.includes('NCT00000001'), 'dated study kept');
  assert.ok(!ids.includes('NCT00000002'), 'dateless study filtered out');
  assert.ok(
    warns.some(w => /NCT00000002/.test(w) && /missing publication date/.test(w)),
    'console.warn fired with the expected NCT id and reason',
  );
});
