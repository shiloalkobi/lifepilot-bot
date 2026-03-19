'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https = require('https');

// ── Validate config ───────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.ALERT_CHAT_ID;

if (!BOT_TOKEN) { console.error('❌ Missing TELEGRAM_BOT_TOKEN in .env'); process.exit(1); }
if (!CHAT_ID)   { console.error('❌ Missing ALERT_CHAT_ID in .env');       process.exit(1); }

// ── Areas to monitor (מרכז / ראשון לציון) ────────────────────────────────────
const MONITORED_AREAS = new Set([
  'ראשון לציון', 'ראשון לציון - מזרח', 'ראשון לציון - מערב',
  'תל אביב - דרום', 'תל אביב - מרכז', 'תל אביב - צפון', 'תל אביב - ירקון',
  'רמת גן', 'גבעתיים', 'פתח תקווה', 'בני ברק',
  'חולון', 'בת ים', 'רמת השרון', 'הרצליה',
  'כפר סבא', 'רעננה', 'הוד השרון', 'נס ציונה',
  'רחובות', 'לוד', 'רמלה', 'מודיעין - מכבים - רעות',
  'יהוד - מונוסון', 'גבעת שמואל', 'קריית אונו', 'אור יהודה',
  'אזור', 'ראש העין', 'אלעד',
]);

// ── Alert types + shelter time (minutes) ─────────────────────────────────────
const ALERT_TYPES = {
  '1':  { emoji: '🚨',    label: 'צבע אדום — ירי רקטות וטילים',       action: 'היכנסו מיד למרחב המוגן',         shelterMin: 10 },
  '2':  { emoji: '🚀🔴', label: 'התרעה מוקדמת — טיל בליסטי מאיראן',  action: 'היכנסו מיד למרחב המוגן! ~3 דקות', shelterMin: 30 },
  '3':  { emoji: '✈️',   label: 'חדירת כטב"ם / מטוס עוין',           action: 'היכנסו למרחב המוגן',              shelterMin: 10 },
  '4':  { emoji: '🌍',   label: 'רעידת אדמה',                         action: 'צאו מהבניין בזהירות',             shelterMin: 0  },
  '6':  { emoji: '☢️',   label: 'אירוע חומרים מסוכנים',               action: 'הישארו בפנים, סגרו חלונות',       shelterMin: 0  },
  '13': { emoji: '🌊',   label: 'אזהרת צונאמי',                       action: 'התרחקו מהחוף לאלתר',              shelterMin: 0  },
};

// ── News RSS feeds ────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: 'חדשות 12', url: 'https://www.mako.co.il/rss/31750a2610f26110VgnVCM1000005201000aRCRD.xml' },
];

const NEWS_MAX_AGE_MS = 1 * 60 * 60 * 1000; // 1 hour

const NEWS_KEYWORDS = [
  'שיגורים', 'שיגור', 'מטח', 'רקטות', 'רקטה',
  'טילים', 'טיל', 'ירי', 'נפילות', 'כטב"מ', 'מל"ט', 'חדירה',
];

// ── State ─────────────────────────────────────────────────────────────────────
let lastAlertId    = null;
let shelterTimer   = null;
let reminderTimer  = null;
const seenNewsKeys = new Set();

// ── Telegram sender ───────────────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      console.error(`Telegram error: ${res.statusCode}`);
    }
  });

  req.on('error', (err) => console.error('Telegram send error:', err.message));
  req.write(body);
  req.end();
}

// ── Shelter countdown ─────────────────────────────────────────────────────────
function startShelterCountdown(minutes) {
  if (shelterTimer)  clearTimeout(shelterTimer);
  if (reminderTimer) clearTimeout(reminderTimer);

  // Halfway reminder (only if shelter > 4 min)
  if (minutes > 4) {
    const half = Math.floor(minutes / 2);
    reminderTimer = setTimeout(() => {
      sendTelegram(`🛡️ נשארו עוד <b>${minutes - half} דקות</b> במרחב המוגן`);
      console.log(`[${timestamp()}] Reminder sent: ${minutes - half} min left`);
    }, half * 60 * 1000);
  }

  // All-clear
  shelterTimer = setTimeout(() => {
    sendTelegram(
      `✅ <b>אפשר לצאת מהמרחב המוגן</b>\n` +
      `עברו ${minutes} דקות מאז ההתראה.`
    );
    console.log(`[${timestamp()}] All-clear sent`);
  }, minutes * 60 * 1000);
}

// ── Oref API ──────────────────────────────────────────────────────────────────
function fetchAlerts() {
  const options = {
    hostname: 'www.oref.org.il',
    path: '/WarningMessages/alert/alerts.json',
    method: 'GET',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.oref.org.il/',
      'User-Agent': 'Mozilla/5.0',
    },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => { processOrefResponse(data.trim()); });
  });

  req.on('error', (err) => console.error('Oref fetch error:', err.message));
  req.setTimeout(5000, () => { req.destroy(); });
  req.end();
}

function processOrefResponse(raw) {
  if (!raw || raw.length < 5) return;

  let alert;
  try { alert = JSON.parse(raw); } catch { return; }

  if (!alert.id || alert.id === lastAlertId) return;
  lastAlertId = alert.id;

  const cities       = Array.isArray(alert.data) ? alert.data : [];
  const matchedCities = cities.filter((c) => MONITORED_AREAS.has(c));
  if (matchedCities.length === 0) return;

  const cat  = String(alert.cat || '1');
  const type = ALERT_TYPES[cat] || { emoji: '⚠️', label: alert.title || 'התראה', action: alert.desc || '', shelterMin: 10 };

  const message =
    `${type.emoji} <b>${type.label}</b>\n\n` +
    `📍 <b>אזורים:</b> ${matchedCities.join(', ')}\n\n` +
    `🛡️ ${type.action}`;

  console.log(`[${timestamp()}] Alert: ${type.label} → ${matchedCities.join(', ')}`);
  sendTelegram(message);

  if (type.shelterMin > 0) {
    startShelterCountdown(type.shelterMin);
  }
}

// ── RSS news polling ──────────────────────────────────────────────────────────
function fetchRSS({ name, url }) {
  const parsed = new URL(url);

  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => { processRSS(name, data); });
  });

  req.on('error', (err) => console.error(`RSS ${name} error:`, err.message));
  req.setTimeout(8000, () => { req.destroy(); });
  req.end();
}

function processRSS(sourceName, xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  for (const item of items) {
    const content = item[1];

    const titleMatch = content.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                       content.match(/<title>(.*?)<\/title>/);
    const linkMatch  = content.match(/<link>(.*?)<\/link>/);
    const guidMatch  = content.match(/<guid[^>]*>(.*?)<\/guid>/);

    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    const link  = linkMatch  ? linkMatch[1].trim()  : '';
    const key   = guidMatch  ? guidMatch[1].trim()  : title;

    if (seenNewsKeys.has(key)) continue;
    seenNewsKeys.add(key);

    // Filter: only last 2 hours
    const pubDateMatch = content.match(/<pubDate>(.*?)<\/pubDate>/);
    if (pubDateMatch) {
      const age = Date.now() - new Date(pubDateMatch[1].trim()).getTime();
      if (age > NEWS_MAX_AGE_MS) continue;
    }

    const matched = NEWS_KEYWORDS.some((kw) => title.includes(kw));
    if (!matched) continue;

    const message =
      `📰 <b>עדכון חדשות — ${sourceName}</b>\n\n` +
      `${title}` +
      (link ? `\n\n🔗 <a href="${link}">קרא עוד</a>` : '');

    console.log(`[${timestamp()}] News: [${sourceName}] ${title}`);
    sendTelegram(message);
  }
}

function pollAllFeeds() {
  RSS_FEEDS.forEach(fetchRSS);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('✅ Oref alert monitor started — watching central Israel');
console.log(`📍 Monitoring ${MONITORED_AREAS.size} areas | RSS: ${RSS_FEEDS.map(f => f.name).join(', ')}`);

sendTelegram(
  '✅ <b>מערכת ההתראות פעילה</b>\n\n' +
  '📍 עוקב אחר: מרכז / ראשון לציון ואזורים סמוכים\n' +
  '🔔 התראות פיקוד העורף + עדכוני חדשות ביטחוניות'
);

// Oref: every 2 seconds
setInterval(fetchAlerts, 2000);
fetchAlerts();

// RSS: every 60 seconds
setInterval(pollAllFeeds, 60 * 1000);
pollAllFeeds();
