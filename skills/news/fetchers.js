'use strict';

/**
 * fetchers.js — 6-category personalized news fetchers for Shilo.
 *
 * Cat 1 — 🤖 AI & Dev Tools    (HN Algolia 24h + Simon Willison)
 * Cat 2 — 🚀 SaaS & Business   (TechCrunch RSS + HN filtered)
 * Cat 3 — 📈 Markets           (Yahoo Finance RSS — significant moves)
 * Cat 4 — 🇮🇱 Israeli Startups (Globes + Calcalist + TechAviv)
 * Cat 5 — 💊 CRPS Research     (PubMed RSS — genuine new research only)
 * Cat 6 — 🌐 Crypto & Web3    (CoinDesk + Decrypt RSS)
 *
 * Every item: { title, url, source, summary, category }
 */

const https = require('https');
const http  = require('http');

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 LifePilot-Bot/2.0',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
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
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`timeout: ${url.slice(0, 60)}`)); });
  });
}

// ── RSS / Atom parser ─────────────────────────────────────────────────────────

function decodeEntities(str = '') {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<[^>]+>/g, '')   // strip HTML tags
    .replace(/\s+/g, ' ')
    .trim();
}

function extractField(block, tag) {
  // Handles CDATA, attributes on tag, multiline
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?((?:(?!\\]\\]>|<\\/${tag}>)[\\s\\S])*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const m  = block.match(re);
  return m ? decodeEntities(m[1]) : '';
}

function extractLink(block) {
  // <link>url</link> or <link href="url"/> or <feedburner:origLink>
  const direct = block.match(/<link[^>]*>(https?:\/\/[^\s<]+)<\/link>/);
  if (direct) return direct[1].trim();
  const attr = block.match(/<link[^>]+href="([^"]+)"/);
  if (attr) return attr[1].trim();
  const orig = block.match(/<feedburner:origLink>(https?:\/\/[^\s<]+)<\/feedburner:origLink>/);
  if (orig) return orig[1].trim();
  return '';
}

function parseRSSItems(xml, limit = 15) {
  const items = [];

  // <item> (RSS 2.0)
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    const title = extractField(block, 'title');
    const url   = extractLink(block);
    const desc  = extractField(block, 'description') || extractField(block, 'content:encoded') || '';
    const pub   = extractField(block, 'pubDate') || extractField(block, 'dc:date') || '';
    if (title && url) items.push({ title, url, description: desc.slice(0, 300), pubDate: pub });
  }

  // <entry> (Atom)
  if (!items.length) {
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    while ((m = entryRe.exec(xml)) !== null && items.length < limit) {
      const block = m[1];
      const title = extractField(block, 'title');
      const url   = extractLink(block);
      const desc  = extractField(block, 'summary') || extractField(block, 'content') || '';
      const pub   = extractField(block, 'published') || extractField(block, 'updated') || '';
      if (title && url) items.push({ title, url, description: desc.slice(0, 300), pubDate: pub });
    }
  }

  return items;
}

// ── Summary helper ────────────────────────────────────────────────────────────

function makeSummary(item) {
  const desc = (item.description || '').trim();
  if (desc && desc.length > 20 && desc.toLowerCase() !== item.title.toLowerCase()) {
    return desc.slice(0, 120).replace(/\s+\S*$/, '') + (desc.length > 120 ? '...' : '');
  }
  return ''; // caller will omit if empty
}

// ── Keyword filters ───────────────────────────────────────────────────────────

const AI_KW = [
  'claude', 'anthropic', 'gemini', 'gpt', 'openai', 'llm', 'ai agent',
  'mcp', 'vibe coding', 'cursor', 'copilot', 'mistral', 'groq',
  'llama', 'diffusion', 'ai model', 'foundation model', 'transformer',
  'chatgpt', 'generative ai', 'large language', 'machine learning',
];

const SAAS_KW = [
  'saas', 'startup', 'funding', 'series a', 'series b', 'series c',
  'seed round', 'raises', 'raised', 'arr', 'churn', 'acquisition',
  'product launch', 'acqui', 'vc', 'venture', 'valuation', 'unicorn',
];

const ISRAEL_KW = [
  'ישראל', 'ישראלי', 'ישראלית', 'israel', 'israeli',
  'startup nation', 'tel aviv', 'wix', 'monday.com', 'fiverr',
  'wiz', 'cyberark', 'mobileye', 'ironsource', 'check point',
  'השקעה', 'גיוס', 'רכישה', 'סטארטאפ', 'ipo', 'funding round',
];

const CRPS_KW = [
  'crps', 'complex regional pain syndrome', 'neuropathic pain',
  'pain treatment', 'ketamine', 'spinal cord stimulation',
  'sympathetically maintained', 'allodynia', 'drg stimulation',
  'new treatment', 'clinical trial', 'pain management',
];

const CRYPTO_KW = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'defi', 'nft', 'web3',
  'blockchain', 'crypto', 'regulation', 'sec', 'stablecoin',
  'layer 2', 'solana', 'polygon', 'dao',
];

function matches(text, kws) {
  const lower = text.toLowerCase();
  return kws.some(k => lower.includes(k));
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function item(raw, source, category) {
  return {
    title:    raw.title,
    url:      raw.url,
    source,
    summary:  makeSummary(raw),
    category,
  };
}

// ── Dedup by URL ──────────────────────────────────────────────────────────────

function dedup(items) {
  const seen = new Set();
  return items.filter(i => {
    const key = i.url.toLowerCase().split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Category 1 — 🤖 AI & Dev Tools ──────────────────────────────────────────

async function fetchAIDev(max = 3) {
  const raw = [];

  // HN Algolia — last 24h
  try {
    const since = Math.floor((Date.now() - 86400000) / 1000);
    const q     = encodeURIComponent('Claude OR Gemini OR GPT OR "AI agent" OR LLM OR Cursor OR Copilot OR Anthropic OR Mistral OR Groq OR MCP');
    const url   = `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=20`;
    const data  = JSON.parse(await httpGet(url));
    for (const h of (data.hits || [])) {
      if (matches(h.title, AI_KW)) {
        raw.push({
          title:       h.title,
          url:         h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          description: h.story_text ? h.story_text.slice(0, 200) : '',
          source:      'Hacker News',
          category:    'ai',
        });
      }
    }
  } catch (e) { console.warn('[News] HN AI:', e.message); }

  // Simon Willison atom
  try {
    const xml = await httpGet('https://simonwillison.net/atom/everything/');
    for (const r of parseRSSItems(xml, 8)) {
      raw.push(item(r, 'Simon Willison', 'ai'));
    }
  } catch (e) { console.warn('[News] SimonWillison:', e.message); }

  return dedup(raw).slice(0, max);
}

// ── Category 2 — 🚀 SaaS & Business ─────────────────────────────────────────

async function fetchSaaS(max = 2) {
  const raw = [];

  // TechCrunch RSS
  try {
    const xml = await httpGet('https://techcrunch.com/feed/');
    for (const r of parseRSSItems(xml, 25)) {
      if (matches(r.title, SAAS_KW)) raw.push(item(r, 'TechCrunch', 'saas'));
    }
  } catch (e) { console.warn('[News] TechCrunch:', e.message); }

  // HN Algolia — SaaS/startup stories last 24h with >50 points
  try {
    const since = Math.floor((Date.now() - 86400000) / 1000);
    const q     = encodeURIComponent('startup OR SaaS OR funding OR "product launch" OR acquisition');
    const url   = `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&numericFilters=created_at_i>${since},points>40&hitsPerPage=10`;
    const data  = JSON.parse(await httpGet(url));
    for (const h of (data.hits || [])) {
      if (matches(h.title, SAAS_KW)) {
        raw.push({
          title: h.title,
          url:   h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          description: '',
          source: 'Hacker News',
          category: 'saas',
        });
      }
    }
  } catch (e) { console.warn('[News] HN SaaS:', e.message); }

  return dedup(raw).slice(0, max);
}

// ── Category 3 — 📈 Markets & Finance ────────────────────────────────────────

const TICKERS = ['AAPL', 'NVDA', 'MSFT', 'GOOGL', 'META', 'TSLA', 'AMZN'];
const MOVE_RE = /([+-]?\d+\.?\d*)\s*%/;

const MARKET_NOISE_KW = [
  'hot dog', 'costco', 'walmart', 'retail', 'store', 'shop',
  'consumer', 'coupon', 'deal', 'sale', 'discount', 'grocery',
  'food', 'restaurant', 'menu', 'price hike', 'membership fee',
];

function isMarketNoise(title) {
  const lower = title.toLowerCase();
  return MARKET_NOISE_KW.some(k => lower.includes(k));
}

function isSignificantMove(title, threshold = 1.5) {
  const m = title.match(MOVE_RE);
  if (!m) return true; // no percentage mentioned — include anyway (earnings, reports)
  return Math.abs(parseFloat(m[1])) >= threshold;
}

async function fetchMarkets(max = 3) {
  const raw = [];

  for (const sym of TICKERS.slice(0, 5)) { // limit concurrent requests
    try {
      const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${sym}&region=US&lang=en-US`;
      const xml = await httpGet(url);
      for (const r of parseRSSItems(xml, 3)) {
        if (isSignificantMove(r.title) && !isMarketNoise(r.title)) {
          raw.push(item({ ...r, description: r.description || r.title }, `Yahoo Finance`, 'market'));
        }
      }
    } catch (e) { console.warn(`[News] Yahoo ${sym}:`, e.message); }
  }

  // BTC/ETH — threshold 3%
  for (const sym of ['BTC-USD', 'ETH-USD']) {
    try {
      const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${sym}&region=US&lang=en-US`;
      const xml = await httpGet(url);
      for (const r of parseRSSItems(xml, 2)) {
        if (isSignificantMove(r.title, 3) && !isMarketNoise(r.title)) {
          raw.push(item({ ...r, description: r.description || r.title }, 'Yahoo Finance', 'market'));
        }
      }
    } catch (e) { console.warn(`[News] Yahoo ${sym}:`, e.message); }
  }

  return dedup(raw).slice(0, max);
}

// ── Category 4 — 🇮🇱 Israeli Startups ────────────────────────────────────────

async function fetchIsraelTech(max = 2) {
  const raw = [];

  // Globes Tech
  try {
    const xml = await httpGet('https://www.globes.co.il/rss/rss_tech.aspx');
    for (const r of parseRSSItems(xml, 10)) {
      raw.push(item(r, 'גלובס', 'israel'));
    }
  } catch (e) { console.warn('[News] Globes:', e.message); }

  // Calcalist Tech
  try {
    const xml = await httpGet('https://www.calcalist.co.il/rss/AID-1523262919788.aspx');
    for (const r of parseRSSItems(xml, 10)) {
      raw.push(item(r, 'כלכליסט', 'israel'));
    }
  } catch (e) { console.warn('[News] Calcalist:', e.message); }

  // TechAviv
  try {
    const xml = await httpGet('https://www.techaviv.com/feed');
    for (const r of parseRSSItems(xml, 8)) {
      if (matches(r.title + ' ' + (r.description || ''), ISRAEL_KW)) {
        raw.push(item(r, 'TechAviv', 'israel'));
      }
    }
  } catch (e) { console.warn('[News] TechAviv:', e.message); }

  // HN — Israeli tech filter
  try {
    const since = Math.floor((Date.now() - 86400000) / 1000);
    const q     = encodeURIComponent('Israel startup OR "Israeli company" OR "Tel Aviv"');
    const url   = `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=8`;
    const data  = JSON.parse(await httpGet(url));
    for (const h of (data.hits || [])) {
      if (matches(h.title, ISRAEL_KW)) {
        raw.push({
          title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          description: '', source: 'Hacker News', category: 'israel',
        });
      }
    }
  } catch (e) { console.warn('[News] HN Israel:', e.message); }

  return dedup(raw).slice(0, max);
}

// ── Category 5 — 💊 CRPS & Chronic Pain ─────────────────────────────────────

const CRPS_STRONG_KW = [
  'crps', 'complex regional pain syndrome', 'drg stimulation',
  'spinal cord stimulation', 'ketamine infusion', 'new treatment',
  'clinical trial', 'randomized', 'systematic review',
];

async function fetchCRPS(max = 1) {
  const raw = [];

  const feeds = [
    'https://pubmed.ncbi.nlm.nih.gov/rss/search/?term=CRPS+treatment&format=rss',
    'https://pubmed.ncbi.nlm.nih.gov/rss/search/?term=complex+regional+pain+syndrome+new+treatment&format=rss',
  ];

  for (const feedUrl of feeds) {
    try {
      const xml = await httpGet(feedUrl);
      for (const r of parseRSSItems(xml, 8)) {
        // Only genuine research/treatment articles
        const text = (r.title + ' ' + (r.description || '')).toLowerCase();
        if (matches(text, CRPS_STRONG_KW)) {
          raw.push(item(r, 'PubMed', 'crps'));
        }
      }
    } catch (e) { console.warn('[News] PubMed:', e.message); }
  }

  return dedup(raw).slice(0, max);
}

// ── Category 6 — 🌐 Crypto & Web3 ────────────────────────────────────────────

const CRYPTO_NOISE_KW = [
  'price prediction', 'buy now', 'will it', 'could reach',
  'moon', 'bull run', 'bear market', 'hodl',
];

function isCryptoNoise(title) {
  return CRYPTO_NOISE_KW.some(k => title.toLowerCase().includes(k));
}

async function fetchCrypto(max = 2) {
  const raw = [];

  // CoinDesk RSS (via Cointelegraph fallback)
  try {
    const xml = await httpGet('https://cointelegraph.com/rss');
    for (const r of parseRSSItems(xml, 15)) {
      if (!isCryptoNoise(r.title) && matches(r.title, CRYPTO_KW)) {
        raw.push(item(r, 'Cointelegraph', 'crypto'));
      }
    }
  } catch (e) { console.warn('[News] CoinDesk:', e.message); }

  // Decrypt RSS
  try {
    const xml = await httpGet('https://decrypt.co/feed');
    for (const r of parseRSSItems(xml, 15)) {
      if (!isCryptoNoise(r.title) && matches(r.title, CRYPTO_KW)) {
        raw.push(item(r, 'Decrypt', 'crypto'));
      }
    }
  } catch (e) { console.warn('[News] Decrypt:', e.message); }

  return dedup(raw).slice(0, max);
}

module.exports = {
  fetchAIDev,
  fetchSaaS,
  fetchMarkets,
  fetchIsraelTech,
  fetchCRPS,
  fetchCrypto,
  domain,
};
