'use strict';

/**
 * fetchers.js — one fetch function per news category.
 *
 * Category 1 — AI & Dev Tools   (HN Algolia + Simon Willison)
 * Category 2 — SaaS & Startups  (TechCrunch RSS + HN filtered)
 * Category 3 — Markets          (Yahoo Finance RSS)
 * Category 4 — Israeli Tech     (Globes RSS + Calcalist RSS)
 */

const https = require('https');

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 LifePilot-Bot/2.0',
        'Accept':     'application/rss+xml, application/xml, text/xml, text/html, */*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      res.setEncoding('utf8');
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`timeout: ${url}`)); });
  });
}

// ── RSS parser (lightweight, no dependencies) ─────────────────────────────────

function parseRSSItems(xml, limit = 10) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    const title = decodeEntities(
      (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || ''
    ).trim();
    const link = (
      (block.match(/<link[^>]*>(https?:\/\/[^\s<]+)<\/link>/) ||
       block.match(/<link[^>]+href="([^"]+)"/) ||
       [])[1] || ''
    ).trim();
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    if (title && link) items.push({ title, url: link, pubDate });
  }
  // Also try atom <entry> format
  if (!items.length) {
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    while ((m = entryRe.exec(xml)) !== null && items.length < limit) {
      const block = m[1];
      const title = decodeEntities(
        (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || ''
      ).trim();
      const link = ((block.match(/<link[^>]+href="([^"]+)"/) || [])[1] || '').trim();
      const pubDate = (block.match(/<published>(.*?)<\/published>/) || [])[1] || '';
      if (title && link) items.push({ title, url: link, pubDate });
    }
  }
  return items;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, ''); // strip any leftover tags
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

// ── Keyword filters ───────────────────────────────────────────────────────────

const AI_KEYWORDS = [
  'claude', 'anthropic', 'gemini', 'gpt', 'openai', 'llm', 'ai agent',
  'cursor', 'copilot', 'mistral', 'llama', 'generative ai', 'chatgpt',
  'ai model', 'foundation model', 'vector', 'langchain', 'transformer',
  'diffusion', 'stable diffusion', 'midjourney', 'sora', 'whisper',
];

const SAAS_KEYWORDS = [
  'saas', 'startup', 'funding', 'series a', 'series b', 'series c',
  'seed round', 'raises', 'raised', 'acqui', 'product launch', 'launch',
  'vc', 'venture', 'valuation', 'unicorn', 'ipo', 'acquisition',
];

const MARKET_SYMBOLS = ['aapl', 'googl', 'msft', 'nvda', 'meta', 'amzn', 'tsla'];
const MARKET_KEYWORDS = [
  ...MARKET_SYMBOLS, 'nasdaq', 's&p', 'dow', 'bitcoin', 'btc', 'ethereum', 'eth',
  'stock', 'shares', 'earnings', 'rally', 'sell-off', 'rate', 'fed', 'inflation',
  'ta-35', 'tel aviv', 'tase',
];

const ISRAEL_KEYWORDS = [
  'ישראל', 'ישראלי', 'ישראלית', 'startup nation', 'tel aviv',
  'wix', 'monday', 'fiverr', 'ironSource', 'check point', 'checkpoint',
  'wiz', 'cyberark', 'radcom', 'mellanox', 'mobileye',
  'funding', 'ipo', 'acquisition', 'השקעה', 'רכישה', 'גיוס', 'סטארטאפ',
];

function matchesAny(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ── Category 1 — AI & Dev Tools ───────────────────────────────────────────────

async function fetchAIDev(max = 3) {
  const items = [];

  // HN Algolia — last 24h AI stories
  try {
    const since = Math.floor((Date.now() - 86400000) / 1000);
    const q     = encodeURIComponent('AI OR LLM OR Claude OR Gemini OR GPT OR Cursor');
    const url   = `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=20`;
    const data  = await httpGet(url);
    const json  = JSON.parse(data);
    for (const h of (json.hits || [])) {
      if (matchesAny(h.title, AI_KEYWORDS)) {
        items.push({
          title:  h.title,
          url:    h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          source: 'HN',
        });
      }
    }
  } catch (e) { console.warn('[News] HN AI fetch failed:', e.message); }

  // Simon Willison atom
  try {
    const xml = await httpGet('https://simonwillison.net/atom/everything/');
    for (const item of parseRSSItems(xml, 6)) {
      items.push({ ...item, source: 'Simon Willison' });
    }
  } catch (e) { console.warn('[News] Simon Willison fetch failed:', e.message); }

  return dedup(items).slice(0, max);
}

// ── Category 2 — SaaS & Startups ─────────────────────────────────────────────

async function fetchSaaS(max = 2) {
  const items = [];

  // TechCrunch RSS
  try {
    const xml = await httpGet('https://techcrunch.com/feed/');
    for (const item of parseRSSItems(xml, 20)) {
      if (matchesAny(item.title, SAAS_KEYWORDS)) {
        items.push({ ...item, source: 'TechCrunch' });
      }
    }
  } catch (e) { console.warn('[News] TechCrunch fetch failed:', e.message); }

  // HN — filtered for startup/saas
  try {
    const since = Math.floor((Date.now() - 86400000) / 1000);
    const q     = encodeURIComponent('startup OR SaaS OR funding OR "product launch"');
    const url   = `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&numericFilters=created_at_i>${since},points>50&hitsPerPage=10`;
    const data  = await httpGet(url);
    const json  = JSON.parse(data);
    for (const h of (json.hits || [])) {
      if (matchesAny(h.title, SAAS_KEYWORDS)) {
        items.push({
          title:  h.title,
          url:    h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          source: 'HN',
        });
      }
    }
  } catch (e) { console.warn('[News] HN SaaS fetch failed:', e.message); }

  return dedup(items).slice(0, max);
}

// ── Category 3 — Markets & Finance ───────────────────────────────────────────

async function fetchMarkets(max = 3) {
  const items = [];

  // Yahoo Finance RSS — tech stocks
  const symbols = ['AAPL', 'GOOGL', 'MSFT', 'NVDA', 'META', 'BTC-USD', 'ETH-USD'];
  for (const sym of symbols.slice(0, 4)) { // limit to avoid too many requests
    try {
      const url  = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${sym}&region=US&lang=en-US`;
      const xml  = await httpGet(url);
      const parsed = parseRSSItems(xml, 3);
      for (const item of parsed) {
        items.push({ ...item, source: `Yahoo Finance (${sym})` });
      }
    } catch (e) { console.warn(`[News] Yahoo Finance ${sym} failed:`, e.message); }
  }

  // Investing.com RSS — general markets
  try {
    const xml  = await httpGet('https://www.investing.com/rss/news.rss');
    const parsed = parseRSSItems(xml, 15);
    for (const item of parsed) {
      if (matchesAny(item.title, MARKET_KEYWORDS)) {
        items.push({ ...item, source: 'Investing.com' });
      }
    }
  } catch (e) { console.warn('[News] Investing.com fetch failed:', e.message); }

  return dedup(items).slice(0, max);
}

// ── Category 4 — Israeli Tech ─────────────────────────────────────────────────

async function fetchIsraelTech(max = 2) {
  const items = [];

  // Globes Tech RSS
  try {
    const xml = await httpGet('https://www.globes.co.il/rss/rss_tech.aspx');
    for (const item of parseRSSItems(xml, 8)) {
      items.push({ ...item, source: 'גלובס' });
    }
  } catch (e) { console.warn('[News] Globes fetch failed:', e.message); }

  // Calcalist Tech RSS
  try {
    const xml = await httpGet('https://www.calcalist.co.il/rss/AID-1523262919788.aspx');
    for (const item of parseRSSItems(xml, 8)) {
      items.push({ ...item, source: 'כלכליסט' });
    }
  } catch (e) { console.warn('[News] Calcalist fetch failed:', e.message); }

  return dedup(items).slice(0, max);
}

// ── Dedup by URL ──────────────────────────────────────────────────────────────

function dedup(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.url.toLowerCase().split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  fetchAIDev,
  fetchSaaS,
  fetchMarkets,
  fetchIsraelTech,
  domain,
};
