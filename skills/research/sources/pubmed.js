'use strict';

const { assertAdapter } = require('./_adapter');

const NCBI_API_KEY = process.env.NCBI_API_KEY || null;
const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

const SEARCH_QUERY =
  '"Complex Regional Pain Syndromes"[MeSH] OR ' +
  '"CRPS"[Title/Abstract] OR ' +
  '"RSD"[Title/Abstract] OR ' +
  '"causalgia"[Title/Abstract] OR ' +
  '"reflex sympathetic dystrophy"[Title/Abstract]';

function buildUrl(path, params) {
  const u = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  if (NCBI_API_KEY) u.searchParams.set('api_key', NCBI_API_KEY);
  return u.toString();
}

function decodeXml(s) {
  if (s == null) return s;
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .trim();
}

function pickTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

function pickAllTags(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parsePublishedAt(block) {
  const pd = pickTag(block, 'PubDate');
  if (!pd) return null;
  const year = pickTag(pd, 'Year');
  if (year) {
    const month = pickTag(pd, 'Month');
    const day = pickTag(pd, 'Day');
    const mm = month ? (MONTHS[month] || String(month).padStart(2, '0')) : '01';
    const dd = day ? String(day).padStart(2, '0') : '01';
    return `${year}-${mm}-${dd}`;
  }
  const md = pickTag(pd, 'MedlineDate');
  if (md) {
    const m = md.match(/(\d{4})/);
    if (m) return `${m[1]}-01-01`;
  }
  return null;
}

function parseAuthors(block) {
  const authors = [];
  for (const a of pickAllTags(block, 'Author')) {
    const last = pickTag(a, 'LastName');
    const fore = pickTag(a, 'ForeName');
    if (last) {
      authors.push(fore ? `${decodeXml(fore)} ${decodeXml(last)}` : decodeXml(last));
    } else {
      const collective = pickTag(a, 'CollectiveName');
      if (collective) authors.push(decodeXml(collective));
    }
  }
  return authors;
}

function parseEfetchXml(xml) {
  const articles = [];
  const blocks = pickAllTags(xml, 'PubmedArticle');
  for (const block of blocks) {
    const pmid = decodeXml(pickTag(block, 'PMID'));
    const titleRaw = pickTag(block, 'ArticleTitle');
    if (!pmid || !titleRaw) continue;

    const absParts = pickAllTags(block, 'AbstractText').map(decodeXml).filter(Boolean);
    const abstract = absParts.length ? absParts.join(' ') : null;

    articles.push({
      source: 'pubmed',
      source_id: pmid,
      title: decodeXml(titleRaw),
      abstract,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      authors: parseAuthors(block),
      published_at: parsePublishedAt(block),
    });
  }
  return articles;
}

function yyyymmdd(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchImpl(query, since) {
  const sinceDate = since instanceof Date ? since : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const term = query ? `(${SEARCH_QUERY}) AND (${query})` : SEARCH_QUERY;

  const searchUrl = buildUrl('esearch.fcgi', {
    db:       'pubmed',
    term,
    retmode:  'json',
    retmax:   20,
    mindate:  yyyymmdd(sinceDate),
    maxdate:  yyyymmdd(new Date()),
    datetype: 'pdat',
  });

  const sRes = await fetch(searchUrl);
  if (!sRes.ok) throw new Error(`PubMed esearch failed: HTTP ${sRes.status}`);
  const sJson = await sRes.json();
  const ids = sJson?.esearchresult?.idlist || [];
  if (!ids.length) return [];

  const fetchUrl = buildUrl('efetch.fcgi', {
    db:      'pubmed',
    id:      ids.join(','),
    retmode: 'xml',
    rettype: 'abstract',
  });
  const fRes = await fetch(fetchUrl);
  if (!fRes.ok) throw new Error(`PubMed efetch failed: HTTP ${fRes.status}`);
  const xml = await fRes.text();
  return parseEfetchXml(xml);
}

const adapter = {
  name: 'pubmed',
  rateLimit: NCBI_API_KEY
    ? { requestsPerSecond: 10, burst: 20 }
    : { requestsPerSecond: 3, burst: 5 },
  fetch: fetchImpl,
  parseId(article) { return article.source_id; },
  async healthCheck() {
    try {
      const url = buildUrl('einfo.fcgi', { db: 'pubmed', retmode: 'json' });
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  },
};

assertAdapter(adapter);

module.exports = adapter;
module.exports.parseEfetchXml = parseEfetchXml;
module.exports.parseAuthors = parseAuthors;
module.exports.parsePublishedAt = parsePublishedAt;
module.exports.decodeXml = decodeXml;
