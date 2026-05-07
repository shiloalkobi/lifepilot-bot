'use strict';

const { assertAdapter } = require('./_adapter');

const BASE = 'https://clinicaltrials.gov/api/v2';

function studiesUrl(params) {
  const u = new URL(`${BASE}/studies`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function parseStudy(s) {
  const ps = s?.protocolSection;
  if (!ps) return null;

  const idm   = ps.identificationModule || {};
  const sm    = ps.statusModule || {};
  const com   = ps.contactsLocationsModule || {};
  const desc  = ps.descriptionModule || {};

  const nctId = idm.nctId;
  if (!nctId) return null;

  const title = idm.briefTitle || idm.officialTitle || nctId;

  const locations = Array.isArray(com.locations) ? com.locations : [];
  const isIsrael = locations.some(l => (l && l.country || '').toLowerCase() === 'israel');

  const investigators = Array.isArray(com.overallOfficials)
    ? com.overallOfficials.map(o => o && o.name).filter(Boolean)
    : [];

  return {
    source: 'clinicaltrials',
    source_id: nctId,
    title,
    abstract: desc.briefSummary || null,
    url: `https://clinicaltrials.gov/study/${nctId}`,
    authors: investigators,
    published_at: sm.startDateStruct?.date || null,
    _meta: {
      recruiting: sm.overallStatus === 'RECRUITING',
      israel:     isIsrael,
      status:     sm.overallStatus || null,
    },
  };
}

async function fetchImpl(query, _since) {
  // Two queries: one global (CRPS), one Israel-scoped. Merge dedup by NCT id.
  // The Israel-only query ensures Israeli trials surface even if not in the
  // top-N global results.
  const seen = new Set();
  const out = [];

  const queries = [
    studiesUrl({
      'query.cond': 'Complex Regional Pain Syndrome',
      ...(query ? { 'query.term': query } : {}),
      pageSize: 20,
    }),
    studiesUrl({
      'query.cond': 'Complex Regional Pain Syndrome',
      'query.locn': 'Israel',
      pageSize: 20,
    }),
  ];

  for (const url of queries) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`CT.gov fetch failed: ${err.message}`);
    }
    if (!res.ok) throw new Error(`CT.gov fetch failed: HTTP ${res.status}`);
    const json = await res.json();
    const studies = Array.isArray(json.studies) ? json.studies : [];
    for (const s of studies) {
      const a = parseStudy(s);
      if (!a) continue;
      if (seen.has(a.source_id)) continue;
      seen.add(a.source_id);
      out.push(a);
    }
  }

  return out;
}

const adapter = {
  name: 'clinicaltrials',
  rateLimit: { requestsPerSecond: 5, burst: 10 },
  fetch: fetchImpl,
  parseId(article) { return article.source_id; },
  async healthCheck() {
    try {
      const url = studiesUrl({
        'query.cond': 'Complex Regional Pain Syndrome',
        pageSize: 1,
      });
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  },
};

assertAdapter(adapter);

module.exports = adapter;
module.exports.parseStudy = parseStudy;
module.exports.studiesUrl = studiesUrl;
