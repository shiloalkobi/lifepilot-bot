'use strict';

/**
 * Web Search Skill — searches the web and returns top results.
 * Primary: Tavily API (TAVILY_API_KEY env var, 1000/month free).
 * Fallback: DuckDuckGo Instant Answer API (no key needed).
 */

const https = require('https');

const name        = 'web-search';
const description = 'Search the web and return top 5 results for a query.';

const tools = [
  {
    name:        'web_search',
    description: 'Search the web. Returns top 5 results with title, snippet, URL.',
    parameters: {
      type:       'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function httpsGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'LifePilot-Bot/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Tavily search ─────────────────────────────────────────────────────────────

async function searchTavily(query) {
  const { status, body } = await httpsPost(
    'api.tavily.com',
    '/search',
    { query, max_results: 5, include_answer: false },
    { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` }
  );

  if (status !== 200) throw new Error(`Tavily HTTP ${status}`);
  const json = JSON.parse(body);

  return (json.results || []).slice(0, 5).map((r) => ({
    title:   r.title   || '',
    snippet: r.content ? r.content.slice(0, 120) : '',
    url:     r.url     || '',
  }));
}

// ── DuckDuckGo fallback ───────────────────────────────────────────────────────

async function searchDDG(query) {
  const q    = encodeURIComponent(query);
  const data = await httpsGet(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`);
  const json = JSON.parse(data);

  const results = [];

  // Abstract (main result)
  if (json.AbstractText && json.AbstractURL) {
    results.push({
      title:   json.Heading || query,
      snippet: json.AbstractText.slice(0, 120),
      url:     json.AbstractURL,
    });
  }

  // Related topics
  for (const t of (json.RelatedTopics || [])) {
    if (results.length >= 5) break;
    if (!t.Text || !t.FirstURL) continue;
    results.push({
      title:   t.Text.split(' - ')[0].slice(0, 80),
      snippet: t.Text.slice(0, 120),
      url:     t.FirstURL,
    });
  }

  return results;
}

// ── Format results ────────────────────────────────────────────────────────────

function formatResults(query, results) {
  if (!results.length) return `🔍 "${query}" — no results found.`;

  const lines = [`🔍 *${query}*\n`];
  results.forEach((r, i) => {
    const snippet = r.snippet ? ` — ${r.snippet}` : '';
    lines.push(`${i + 1}. ${r.title}${snippet}\n   ${r.url}`);
  });
  return lines.join('\n');
}

// ── Skill execute ─────────────────────────────────────────────────────────────

async function execute(toolName, args, ctx) {
  if (toolName !== 'web_search') return `Unknown tool "${toolName}" in skill "${name}"`;

  const query = (args.query || '').trim();
  if (!query) return '⚠️ No search query provided.';

  console.log(`[Skills] web-search: "${query}"`);

  try {
    let results;
    if (process.env.TAVILY_API_KEY) {
      console.log('[Skills] web-search: using Tavily');
      results = await searchTavily(query);
    } else {
      console.log('[Skills] web-search: TAVILY_API_KEY not set — falling back to DuckDuckGo');
      results = await searchDDG(query);
    }
    console.log(`[Skills] web-search: ${results.length} results`);
    return formatResults(query, results);
  } catch (err) {
    console.error('[Skills] web-search error:', err.message);
    // If Tavily failed, try DDG as last resort
    if (process.env.TAVILY_API_KEY) {
      try {
        const results = await searchDDG(query);
        return formatResults(query, results);
      } catch {}
    }
    return `⚠️ Web search failed: ${err.message}`;
  }
}

module.exports = { name, description, tools, execute };
