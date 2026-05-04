'use strict';

const { assertAdapter } = require('./_adapter');

const BASE = 'https://api.medrxiv.org';

// medRxiv has no keyword search API — we fetch a recent date range and
// filter client-side. CRPS preprints are rare (single digits per year per
// Mary §1.1), so this is acceptable.
const CRPS_PATTERNS = [
  /complex regional pain syndrome/i,
  /\bCRPS\b/,
  /reflex sympathetic dystrophy/i,
  /\bcausalgia\b/i,
];

function isCrpsPaper(paper) {
  const haystack = [paper && paper.title, paper && paper.abstract, paper && paper.category]
    .filter(Boolean)
    .join('\n');
  return CRPS_PATTERNS.some(re => re.test(haystack));
}

function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function parsePaper(p) {
  if (!p || !p.doi || !p.title) return null;
  const authors = String(p.authors || '')
    .split(/;\s*/)
    .map(a => a.trim())
    .filter(Boolean);
  const version = p.version || '1';
  return {
    source:       'medrxiv',
    source_id:    p.doi,
    title:        String(p.title).trim(),
    abstract:     p.abstract ? String(p.abstract).trim() : null,
    url:          `https://www.medrxiv.org/content/${p.doi}v${version}`,
    authors,
    published_at: p.date || null,
  };
}

async function fetchPage(from, to, cursor) {
  const url = `${BASE}/details/medrxiv/${from}/${to}/${cursor}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`medRxiv fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function fetchImpl(query, since) {
  const sinceDate = since instanceof Date ? since : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const from = isoDate(sinceDate);
  const to   = isoDate(new Date());

  const out = [];
  let cursor = 0;
  // Cap at 3 pages (300 papers) — bounds runtime on cold cache.
  for (let page = 0; page < 3; page++) {
    const json = await fetchPage(from, to, cursor);
    const collection = Array.isArray(json.collection) ? json.collection : [];
    if (!collection.length) break;

    for (const p of collection) {
      if (!isCrpsPaper(p)) continue;
      const a = parsePaper(p);
      if (!a) continue;
      if (query) {
        const q = String(query).toLowerCase();
        const hay = `${a.title}\n${a.abstract || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(a);
    }

    const advanced = (json.messages && json.messages[0] && json.messages[0].count) || collection.length;
    if (advanced < 100) break;
    cursor += advanced;
  }

  return out;
}

const adapter = {
  name: 'medrxiv',
  rateLimit: { requestsPerSecond: 2, burst: 4 },
  fetch: fetchImpl,
  parseId(article) { return article.source_id; },
  async healthCheck() {
    try {
      const today = isoDate(new Date());
      const yesterday = isoDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const url = `${BASE}/details/medrxiv/${yesterday}/${today}/0`;
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  },
};

assertAdapter(adapter);

module.exports = adapter;
module.exports.isCrpsPaper = isCrpsPaper;
module.exports.parsePaper = parsePaper;
module.exports.isoDate = isoDate;
