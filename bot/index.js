require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err?.message || err);
});

const http = require('http');
const { startBot }                  = require('./telegram');
const { startOrefMonitor, sendMockAlert } = require('./oref');
const { startScheduler }            = require('./scheduler');
const { scheduleMedications }       = require('./medications');

const token       = process.env.TELEGRAM_BOT_TOKEN;
const apiKey      = process.env.GROQ_API_KEY;
const alertChatId = process.env.ALERT_CHAT_ID;
const renderUrl   = process.env.RENDER_EXTERNAL_URL;
const cronSecret  = process.env.CRON_SECRET; // protect /cron/* endpoints

if (!token) { console.error('❌ Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }
if (!apiKey) { console.error('❌ Missing GROQ_API_KEY');        process.exit(1); }

// ── Webhook vs polling ────────────────────────────────────────────────────────
const webhookUrl = renderUrl ? `${renderUrl}/bot${token}` : null;
const bot = startBot(token, webhookUrl);

// ── Scheduler ─────────────────────────────────────────────────────────────────
const mainChatId = alertChatId || process.env.CHAT_ID;
let cronActions  = null; // populated below

if (mainChatId) {
  cronActions = startScheduler(bot, mainChatId);
  scheduleMedications(bot, mainChatId);
}

// ── Pikud HaOref ──────────────────────────────────────────────────────────────
if (alertChatId) {
  startOrefMonitor(bot, alertChatId);
  if (process.env.TEST_ALERT === '1') {
    setTimeout(() => sendMockAlert(bot, alertChatId), 2000);
  }
} else {
  console.warn('⚠️ ALERT_CHAT_ID not set — Oref alerts disabled');
}

// ── "Sent today" deduplication ────────────────────────────────────────────────
// In-memory flags — reset at midnight IL
const sentToday = { morning: null, english: null, summary: null };

function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function alreadySentToday(key) {
  return sentToday[key] === todayIL();
}

function markSentToday(key) {
  sentToday[key] = todayIL();
}

// ── Cron endpoint handler ─────────────────────────────────────────────────────
async function handleCronRoute(route, res) {
  if (!mainChatId || !cronActions) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Bot not configured' }));
    return;
  }

  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (route === '/cron/morning') {
    if (alreadySentToday('morning')) return json({ ok: true, action: 'already_sent_today' });
    await cronActions.sendMorning();
    markSentToday('morning');
    return json({ ok: true, action: 'morning_sent' });
  }

  if (route === '/cron/english') {
    if (alreadySentToday('english')) return json({ ok: true, action: 'already_sent_today' });
    await cronActions.sendEnglishWord();
    markSentToday('english');
    return json({ ok: true, action: 'english_sent' });
  }

  if (route === '/cron/summary') {
    if (alreadySentToday('summary')) return json({ ok: true, action: 'already_sent_today' });
    await cronActions.sendDailySummary();
    markSentToday('summary');
    return json({ ok: true, action: 'summary_sent' });
  }

  if (route === '/cron/health') {
    const { getUsage } = require('./rate-limiter');
    const usage = getUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime:  Math.round(process.uptime()),
      sentToday,
      rateLimit: usage,
      ts: new Date().toISOString(),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const urlObj  = new URL(req.url, `http://localhost`);
  const route   = urlObj.pathname;
  const keyParam = urlObj.searchParams.get('key');

  // Webhook endpoint
  if (webhookUrl && req.method === 'POST' && route === `/bot${token}`) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { bot.processUpdate(JSON.parse(body)); } catch (err) {
        console.error('[Webhook] processUpdate error:', err.message);
      }
      res.writeHead(200);
      res.end('OK');
    });
    return;
  }

  // Cron endpoints — require secret key
  if (route.startsWith('/cron/')) {
    if (cronSecret && keyParam !== cronSecret) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
      return;
    }
    handleCronRoute(route, res).catch((err) => {
      console.error('[Cron] Handler error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // Default keep-alive
  res.writeHead(200);
  res.end('LifePilot bot is running');
});

server.listen(PORT, () => {
  console.log(`✅ HTTP server listening on port ${PORT}`);
});
