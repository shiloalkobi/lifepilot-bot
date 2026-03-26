'use strict';

/**
 * AI News Skill — fetches top AI / Claude Code stories of the day.
 * Sources: HN Algolia search + Simon Willison atom feed.
 * Agent tool: get_ai_news
 * Also exported: fetchAINews, formatAINews (used by index.js cron)
 */

const https = require('https');

const name        = 'ai-news';
const description = 'Fetches top 5 AI/Claude Code news stories today.';

const tools = [
  {
    name:        'get_ai_news',
    description: 'Get top 5 AI/Claude Code news stories today.',
    parameters: {
      type:       'object',
      properties: {},
      required:   [],
    },
  },
];

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'LifePilot-Bot/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
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

// ── Source: Hacker News Algolia search (last 48h) ─────────────────────────────

async function fetchHNAINews() {
  const since = Math.floor((Date.now() - 172800000) / 1000); // 48h ago
  const query = encodeURIComponent('Claude OR Anthropic OR "AI agent" OR "LLM"');
  const url   = `https://hn.algolia.com/api/v1/search?query=${query}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=8`;

  const data = await httpGet(url);
  const json = JSON.parse(data);

  return (json.hits || []).slice(0, 5).map((h) => ({
    title:  h.title,
    url:    h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    source: 'Hacker News',
  }));
}

// ── Source: Simon Willison atom feed ─────────────────────────────────────────

async function fetchSimonWillisonFeed() {
  const data    = await httpGet('https://simonwillison.net/atom/everything/');
  const entries = [];
  const re      = /<entry>([\s\S]*?)<\/entry>/g;
  let m;

  while ((m = re.exec(data)) !== null && entries.length < 4) {
    const block = m[1];
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    const link  = (block.match(/<link[^>]+href="([^"]+)"/) || [])[1] || '';
    if (title && link) {
      entries.push({ title: title.trim(), url: link, source: 'Simon Willison' });
    }
  }
  return entries;
}

// ── Merge, deduplicate, limit ─────────────────────────────────────────────────

async function fetchAINews() {
  const results = await Promise.allSettled([fetchHNAINews(), fetchSimonWillisonFeed()]);

  const stories = [];
  for (const r of results) {
    if (r.status === 'fulfilled') stories.push(...r.value);
  }

  const seen = new Set();
  return stories.filter((s) => {
    const key = s.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

// ── Format ────────────────────────────────────────────────────────────────────

function formatAINews(stories) {
  if (!stories || stories.length === 0) {
    return '📡 <b>AI News</b>\n\nNo stories found today.';
  }
  const lines = ['🤖 <b>AI News Today</b>\n'];
  stories.forEach((s, i) => {
    lines.push(`${i + 1}. <a href="${s.url}">${s.title}</a> — <i>${s.source}</i>`);
  });
  return lines.join('\n');
}

// ── Skill execute ─────────────────────────────────────────────────────────────

async function execute(toolName, args, ctx) {
  if (toolName === 'get_ai_news') {
    try {
      console.log('[Skills] ai-news: fetching...');
      const stories = await fetchAINews();
      console.log(`[Skills] ai-news: found ${stories.length} stories`);
      return formatAINews(stories);
    } catch (err) {
      console.error('[Skills] ai-news error:', err.message);
      return '⚠️ Could not fetch AI news right now. Try again later.';
    }
  }
  return `Unknown tool "${toolName}" in skill "${name}"`;
}

module.exports = { name, description, tools, execute, fetchAINews, formatAINews };
