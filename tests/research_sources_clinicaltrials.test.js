'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ct = require('../skills/research/sources/clinicaltrials');
const { parseStudy, studiesUrl } = ct;

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
      statusModule:         { overallStatus: 'RECRUITING' },
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
