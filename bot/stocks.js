'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { supabase, isEnabled } = require('./supabase');

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

// ── Watchlist persistence (JSON fallback) ─────────────────────────────────────

function loadFromJson() {
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); }
  catch { return []; }
}

function saveToJson(list) {
  try {
    fs.mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true });
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.warn('[stocks] JSON save failed:', e.message);
  }
}

function rowToWatch(r) {
  return {
    id:        r.id,
    chatId:    r.chat_id,
    symbol:    r.symbol,
    threshold: r.threshold,
    direction: r.direction || 'above',
    triggered: !!r.triggered,
    createdAt: r.created_at,
  };
}

async function loadWatchlist() {
  if (isEnabled()) {
    const { data, error } = await supabase
      .from('watchlist')
      .select('*')
      .order('id', { ascending: true });
    if (!error && Array.isArray(data)) return data.map(rowToWatch);
    if (error) console.warn('[Supabase] watchlist load error:', error.message);
  }
  return loadFromJson();
}

async function upsertWatch(entry) {
  if (isEnabled()) {
    const { error } = await supabase.from('watchlist').upsert({
      id:         entry.id,
      chat_id:    String(entry.chatId),
      symbol:     entry.symbol,
      threshold:  entry.threshold,
      direction:  entry.direction,
      triggered:  entry.triggered,
      created_at: entry.createdAt,
    }, { onConflict: 'id' });
    if (error) console.warn('[Supabase] watchlist upsert error:', error.message);
  }

  const list = loadFromJson();
  const idx = list.findIndex(w => w.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  saveToJson(list);
}

async function deleteWatchRows(predicate) {
  const list    = loadFromJson();
  const keep    = list.filter(w => !predicate(w));
  const removed = list.filter(predicate);

  if (isEnabled()) {
    for (const r of removed) {
      const { error } = await supabase.from('watchlist').delete().eq('id', r.id);
      if (error) console.warn('[Supabase] watchlist delete error:', error.message);
    }
  }
  saveToJson(keep);
  return removed;
}

function nextId(list) {
  return list.length ? Math.max(...list.map(w => w.id)) + 1 : 1;
}

// ── Watchlist operations ──────────────────────────────────────────────────────

async function addToWatchlist(chatId, symbol, threshold, direction = 'above') {
  // Remove any existing entry for same symbol+chatId
  await deleteWatchRows(w =>
    String(w.chatId) === String(chatId) && w.symbol === symbol.toUpperCase()
  );

  const list = await loadWatchlist();
  const entry = {
    id:        nextId(list),
    chatId:    String(chatId),
    symbol:    symbol.toUpperCase(),
    threshold: threshold != null ? parseFloat(threshold) : null,
    direction,
    triggered: false,
    createdAt: new Date().toISOString(),
  };
  await upsertWatch(entry);
  return entry;
}

async function removeFromWatchlist(chatId, symbol) {
  const removed = await deleteWatchRows(w =>
    String(w.chatId) === String(chatId) && w.symbol === symbol.toUpperCase()
  );
  return removed.length > 0;
}

async function getWatchlistForChat(chatId) {
  const list = await loadWatchlist();
  return list.filter(w => String(w.chatId) === String(chatId));
}

// ── Format watchlist with live prices ────────────────────────────────────────

async function formatWatchlist(chatId) {
  const items = await getWatchlistForChat(chatId);
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
  const list = await getWatchlistForChat(chatId);
  if (!list.length) return;

  for (const w of list) {
    if (w.threshold == null) continue;
    try {
      const s         = await fetchStockPrice(w.symbol);
      const triggered = w.direction === 'above'
        ? s.price >= w.threshold
        : s.price <= w.threshold;

      if (triggered && !w.triggered) {
        const sign = s.changePct >= 0 ? '+' : '';
        const dir  = w.direction === 'above' ? 'עלתה מעל' : 'ירדה מתחת';
        await bot.sendMessage(chatId,
          `🚨 <b>התראת מניה!</b>\n\n` +
          `<b>${s.symbol}</b> ${dir} $${w.threshold}!\n` +
          `מחיר נוכחי: $${s.price} (${sign}${s.changePct}%)\n` +
          `${s.name}`,
          { parse_mode: 'HTML' }
        );
        await upsertWatch({ ...w, triggered: true });
      } else if (!triggered && w.triggered) {
        await upsertWatch({ ...w, triggered: false });
      }
    } catch (e) {
      console.warn(`[Stocks] checkAlerts ${w.symbol}:`, e.message);
    }
  }
}

// ── Default watchlist initializer ─────────────────────────────────────────────

async function initDefaultWatchlist(chatId) {
  const existing = await getWatchlistForChat(chatId);
  if (existing.length) return;

  const defaults = [
    { symbol: 'NVDA'    },
    { symbol: 'AAPL'    },
    { symbol: 'MSFT'    },
    { symbol: 'GOOGL'   },
    { symbol: 'META'    },
    { symbol: 'BTC-USD' },
  ];

  for (const d of defaults) {
    const list = await loadWatchlist();
    const entry = {
      id:        nextId(list),
      chatId:    String(chatId),
      symbol:    d.symbol,
      threshold: null,
      direction: 'above',
      triggered: false,
      createdAt: new Date().toISOString(),
    };
    await upsertWatch(entry);
  }
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
