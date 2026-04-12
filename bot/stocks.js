'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const WATCHLIST_FILE = path.join(__dirname, '..', 'data', 'stock-watchlist.json');

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://finance.yahoo.com',
        'Origin':          'https://finance.yahoo.com',
      },
    }, (res) => {
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

// ── Yahoo Finance fetch ───────────────────────────────────────────────────────

async function fetchStockPrice(symbol) {
  const url  = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}`;
  const data = JSON.parse(await httpGet(url));
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`לא נמצא מחיר עבור ${symbol}`);

  const price      = meta.regularMarketPrice;
  const prevClose  = meta.chartPreviousClose || meta.previousClose || price;
  const change     = price - prevClose;
  const changePct  = prevClose ? ((change / prevClose) * 100) : 0;
  const name       = meta.shortName || meta.longName || symbol.toUpperCase();
  const currency   = meta.currency || 'USD';

  return {
    symbol:    symbol.toUpperCase(),
    name,
    price:     Math.round(price * 100) / 100,
    change:    Math.round(change * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    currency,
  };
}

function formatPrice(stock) {
  const dir   = stock.changePct >= 0 ? '📈' : '📉';
  const sign  = stock.changePct >= 0 ? '+' : '';
  return (
    `${dir} <b>${stock.symbol}</b> — ${stock.currency} ${stock.price.toLocaleString()}\n` +
    `   ${sign}${stock.change} (${sign}${stock.changePct}%) | ${stock.name}`
  );
}

// ── Watchlist persistence ─────────────────────────────────────────────────────

function loadWatchlist() {
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); }
  catch { return []; }
}

function saveWatchlist(list) {
  fs.mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true });
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function nextId(list) {
  return list.length ? Math.max(...list.map(w => w.id)) + 1 : 1;
}

// ── Watchlist operations ──────────────────────────────────────────────────────

/**
 * Add a stock alert.
 * @param {string} chatId
 * @param {string} symbol  e.g. "NVDA"
 * @param {number} threshold  price to alert at
 * @param {'above'|'below'} direction
 */
function addToWatchlist(chatId, symbol, threshold, direction = 'above') {
  const list = loadWatchlist();
  // Remove existing entry for same symbol+chatId
  const filtered = list.filter(w => !(w.chatId === chatId && w.symbol === symbol.toUpperCase()));
  filtered.push({
    id:        nextId(list),
    chatId,
    symbol:    symbol.toUpperCase(),
    threshold: parseFloat(threshold),
    direction,
    triggered: false,
    createdAt: new Date().toISOString(),
  });
  saveWatchlist(filtered);
  return filtered[filtered.length - 1];
}

function removeFromWatchlist(chatId, symbol) {
  const list     = loadWatchlist();
  const filtered = list.filter(w => !(w.chatId === chatId && w.symbol === symbol.toUpperCase()));
  saveWatchlist(filtered);
  return list.length !== filtered.length;
}

function getWatchlistForChat(chatId) {
  return loadWatchlist().filter(w => w.chatId === chatId);
}

// ── Format watchlist with live prices ────────────────────────────────────────

async function formatWatchlist(chatId) {
  const items = getWatchlistForChat(chatId);
  if (!items.length) {
    return '📋 אין מניות במעקב.\n\nהוסף: "תעקוב אחרי NVDA ותתריע ב-150$"';
  }

  const lines = ['📋 <b>ווצ\'ליסט מניות:</b>\n'];
  for (const w of items) {
    try {
      const s    = await fetchStockPrice(w.symbol);
      const sign = s.changePct >= 0 ? '+' : '';
      const alertStr = w.threshold != null
        ? `${w.direction === 'above' ? '↑' : '↓'} $${w.threshold}`
        : 'אין התראה';
      lines.push(
        `• <b>${s.symbol}</b> — $${s.price} (${sign}${s.changePct}%) | ${s.name}\n` +
        `  התראה: ${alertStr}`
      );
    } catch {
      lines.push(`• <b>${w.symbol}</b> — מחיר לא זמין`);
    }
  }
  return lines.join('\n');
}

// ── Alert checker (called by cron) ───────────────────────────────────────────

async function checkAlerts(bot, chatId) {
  const list = loadWatchlist().filter(w => w.chatId === chatId);
  if (!list.length) return;

  let changed = false;
  const all   = loadWatchlist();

  for (const w of list) {
    if (w.threshold == null) continue; // tracking-only entry, no alert needed
    try {
      const s         = await fetchStockPrice(w.symbol);
      const triggered = w.direction === 'above'
        ? s.price >= w.threshold
        : s.price <= w.threshold;

      const entry = all.find(x => x.id === w.id);
      if (!entry) continue;

      if (triggered && !entry.triggered) {
        const sign = s.changePct >= 0 ? '+' : '';
        const dir  = w.direction === 'above' ? 'עלתה מעל' : 'ירדה מתחת';
        await bot.sendMessage(chatId,
          `🚨 <b>התראת מניה!</b>\n\n` +
          `<b>${s.symbol}</b> ${dir} $${w.threshold}!\n` +
          `מחיר נוכחי: $${s.price} (${sign}${s.changePct}%)\n` +
          `${s.name}`,
          { parse_mode: 'HTML' }
        );
        entry.triggered = true;
        changed = true;
      } else if (!triggered && entry.triggered) {
        // Reset trigger so it can fire again when threshold is crossed again
        entry.triggered = false;
        changed = true;
      }
    } catch (e) {
      console.warn(`[Stocks] checkAlerts ${w.symbol}:`, e.message);
    }
  }

  if (changed) saveWatchlist(all);
}

// ── Default watchlist initializer ─────────────────────────────────────────────

function initDefaultWatchlist(chatId) {
  const existing = getWatchlistForChat(chatId);
  if (existing.length) return; // already has entries

  // Defaults: tracking only (no alert threshold) — survives Render deploys
  const defaults = [
    { symbol: 'NVDA'    },
    { symbol: 'AAPL'    },
    { symbol: 'MSFT'    },
    { symbol: 'GOOGL'   },
    { symbol: 'META'    },
    { symbol: 'BTC-USD' },
  ];

  const list = loadWatchlist();
  for (const d of defaults) {
    list.push({
      id:        nextId(list),
      chatId,
      symbol:    d.symbol,
      threshold: null,        // no price alert — tracking only
      direction: 'above',
      triggered: false,
      createdAt: new Date().toISOString(),
    });
  }
  saveWatchlist(list);
}

module.exports = {
  fetchStockPrice,
  formatPrice,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlistForChat,
  formatWatchlist,
  checkAlerts,
  initDefaultWatchlist,
};
