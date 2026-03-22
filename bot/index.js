require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Prevent unhandled Telegram/network errors from crashing the process
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err?.message || err);
});

const http = require('http');
const { startBot } = require('./telegram');
const { startOrefMonitor, sendMockAlert } = require('./oref');
const { startScheduler } = require('./scheduler');

const token   = process.env.TELEGRAM_BOT_TOKEN;
const apiKey  = process.env.GROQ_API_KEY;
const alertChatId = process.env.ALERT_CHAT_ID;

if (!token) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

if (!apiKey) {
  console.error('❌ Missing GROQ_API_KEY in .env');
  process.exit(1);
}

// Render requires a listening port — keep-alive HTTP server
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('LifePilot bot is running');
});
server.listen(PORT, () => {
  console.log(`✅ HTTP server listening on port ${PORT}`);
});

const bot = startBot(token);

// Start daily scheduler (morning briefing at 07:00 IL)
const mainChatId = alertChatId || process.env.CHAT_ID;
if (mainChatId) {
  const scheduler = startScheduler(bot, mainChatId);
  // Register the /boker on-demand handler in telegram.js context
  bot._scheduler = scheduler;
}

// Start Pikud HaOref real-time alert monitor (1s polling, integrated)
if (alertChatId) {
  startOrefMonitor(bot, alertChatId);
  // Run mock alert test if TEST_ALERT=1 (for format verification)
  if (process.env.TEST_ALERT === '1') {
    setTimeout(() => sendMockAlert(bot, alertChatId), 2000);
  }
} else {
  console.warn('⚠️ ALERT_CHAT_ID not set — Oref alerts disabled');
}
