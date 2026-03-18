require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { startBot } = require('./telegram');

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.GROQ_API_KEY;

if (!token) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

if (!apiKey) {
  console.error('❌ Missing GROQ_API_KEY in .env');
  process.exit(1);
}

startBot(token);
