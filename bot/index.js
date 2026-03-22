require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err?.message || err);
});

const http = require('http');
const { startBot } = require('./telegram');
const { startOrefMonitor, sendMockAlert } = require('./oref');
const { startScheduler } = require('./scheduler');

const token       = process.env.TELEGRAM_BOT_TOKEN;
const apiKey      = process.env.GROQ_API_KEY;
const alertChatId = process.env.ALERT_CHAT_ID;
const renderUrl   = process.env.RENDER_EXTERNAL_URL; // set automatically by Render

if (!token) { console.error('❌ Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }
if (!apiKey) { console.error('❌ Missing GROQ_API_KEY');        process.exit(1); }

// ── Webhook vs polling ────────────────────────────────────────────────────────
// On Render: use webhook (no polling conflicts, Telegram pushes to us)
// Locally:   use polling (no public URL available)
const webhookUrl = renderUrl ? `${renderUrl}/bot${token}` : null;
const bot = startBot(token, webhookUrl);

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Webhook endpoint: Telegram POSTs updates here
  if (webhookUrl && req.method === 'POST' && req.url === `/bot${token}`) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        bot.processUpdate(JSON.parse(body));
      } catch (err) {
        console.error('[Webhook] processUpdate error:', err.message);
      }
      res.writeHead(200);
      res.end('OK');
    });
    return;
  }

  // Health check / keep-alive
  res.writeHead(200);
  res.end('LifePilot bot is running');
});

server.listen(PORT, () => {
  console.log(`✅ HTTP server listening on port ${PORT}`);
});

// ── Scheduler ─────────────────────────────────────────────────────────────────
const mainChatId = alertChatId || process.env.CHAT_ID;
if (mainChatId) {
  startScheduler(bot, mainChatId);
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
