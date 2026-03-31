require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err?.message || err);
});

const http = require('http');
const cron = require('node-cron');
const { startBot }                  = require('./telegram');
const { startOrefMonitor, sendMockAlert } = require('./oref');
const { startProactiveScheduler }   = require('./proactive');
const { startScheduler }            = require('./scheduler');
const { scheduleMedications }       = require('./medications');
const { startReminderScheduler }    = require('./reminders');
const { startSiteMonitor }          = require('./sites');

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

startReminderScheduler(bot);

// ── Rate limiter alert hook ───────────────────────────────────────────────────
{
  const { setAlertFn } = require('./rate-limiter');
  const alertTarget = process.env.TELEGRAM_CHAT_ID || mainChatId;
  if (alertTarget) {
    setAlertFn((msg) => bot.sendMessage(alertTarget, msg, { parse_mode: 'HTML' }));
  }
}

// ── Proactive scheduler (Shabbat + morning + health reminder) ─────────────────
{
  const proactiveChatId = process.env.TELEGRAM_CHAT_ID || mainChatId;
  if (proactiveChatId) {
    startProactiveScheduler(bot, proactiveChatId);
  } else {
    console.warn('[Proactive] TELEGRAM_CHAT_ID not set — scheduler disabled');
  }
}

// ── AI News cron — 08:30 Israel time daily ────────────────────────────────────
{
  const AI_NEWS_CHAT = '758752313';
  const { fetchAINews, formatAINews } = require('../skills/ai-news');

  cron.schedule('30 8 * * *', async () => {
    try {
      console.log('[Cron] Sending AI news...');
      const stories = await fetchAINews();
      const msg     = formatAINews(stories);
      await bot.sendMessage(AI_NEWS_CHAT, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
      console.log('[Cron] AI news sent');
    } catch (err) {
      console.error('[Cron] AI news error:', err.message);
    }
  }, { timezone: 'Asia/Jerusalem' });

  console.log('✅ [Cron] AI news scheduled at 08:30 IL daily');
}

// ── WordPress / Site Monitor ──────────────────────────────────────────────────
startSiteMonitor(bot, mainChatId || alertChatId);

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
const sentToday = { morning: null, english: null, news: null, summary: null, weekly: null };

function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function alreadySentToday(key) {
  return sentToday[key] === todayIL();
}

function markSentToday(key) {
  sentToday[key] = todayIL();
}

// ── Response helpers ──────────────────────────────────────────────────────────
// Keep responses TINY — cron-job.org has a strict response-size limit.
// No Content-Type, no Date (disabled on server), Connection: close (no Keep-Alive header).
const OK_BODY = '{"ok":true}';
const OK_LEN  = String(Buffer.byteLength(OK_BODY)); // '11'

function respondOk(res) {
  res.sendDate = false; // belt-and-suspenders alongside server.sendDate = false
  res.writeHead(200, { 'Content-Length': OK_LEN, 'Connection': 'close' });
  res.end(OK_BODY);
}

function respondErr(res, code, msg) {
  const body = `{"ok":false,"e":"${msg}"}`;
  res.sendDate = false;
  res.writeHead(code, { 'Content-Length': String(Buffer.byteLength(body)), 'Connection': 'close' });
  res.end(body);
}

// ── Cron endpoint handler ─────────────────────────────────────────────────────
// Pattern: respond {"ok":true} immediately, do heavy work async after.
// Mark dedup BEFORE responding to prevent double-fire on concurrent requests.
function handleCronRoute(route, res) {
  if (!mainChatId || !cronActions) return respondErr(res, 503, 'not_configured');

  const ACTIONS = {
    '/cron/morning': ['morning', () => cronActions.sendMorning()],
    '/cron/english': ['english', () => cronActions.sendEnglishWord()],
    '/cron/news':    ['news',    () => cronActions.sendDailyNews()],
    '/cron/summary': ['summary', () => cronActions.sendDailySummary()],
    '/cron/weekly':  ['weekly',  () => cronActions.sendWeeklySummary()],
  };

  const entry = ACTIONS[route];
  if (entry) {
    const [key, fn] = entry;
    if (alreadySentToday(key)) return respondOk(res); // already done today
    markSentToday(key);   // mark first — prevents double-fire
    respondOk(res);       // respond immediately (tiny body, no timeout)
    fn().catch((err) => { // do the real work async, after HTTP response is sent
      console.error(`[Cron] ${route} async error:`, err.message);
    });
    return;
  }

  if (route === '/cron/health') {
    const { getUsage } = require('./rate-limiter');
    const u    = getUsage();
    const body = `{"ok":true,"up":${Math.round(process.uptime())},"sent":${JSON.stringify(sentToday)},"rl":${JSON.stringify(u)}}`;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  respondErr(res, 404, 'not_found');
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
      res.writeHead(200, { 'Content-Length': '2' });
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
    handleCronRoute(route, res);
    return;
  }

  // Default keep-alive / wake-up ping — 2 bytes
  res.sendDate = false;
  res.writeHead(200, { 'Content-Length': '2', 'Connection': 'close' });
  res.end('OK');
});

// Disable automatic Date header — keeps responses tiny for cron-job.org
server.sendDate = false;

server.listen(PORT, () => {
  console.log(`✅ HTTP server listening on port ${PORT}`);
});
