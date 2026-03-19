const TelegramBot = require('node-telegram-bot-api');
const { askClaude } = require('./claude');
const { getHistory, addMessage, resetHistory } = require('./history');

function startBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      '👋 שלום! אני LifePilot, העוזר האישי שלך.\n\nשלח לי הודעה כלשהי ואענה.\n\n/reset — מחיקת היסטוריית שיחה\n/help — עזרה'
    );
  });

  bot.onText(/\/reset/, (msg) => {
    resetHistory(msg.chat.id);
    bot.sendMessage(msg.chat.id, '🗑️ היסטוריית השיחה נמחקה.');
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      '📋 *פקודות זמינות:*\n\n/start — ברכה\n/reset — מחיקת היסטוריה\n/help — עזרה\n\nכל הודעה אחרת → Claude',
      { parse_mode: 'Markdown' }
    );
  });

  // Handle all non-command messages
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;

    // Show "typing..." indicator
    bot.sendChatAction(chatId, 'typing');

    addMessage(chatId, 'user', msg.text);

    try {
      const reply = await askClaude(getHistory(chatId));
      addMessage(chatId, 'assistant', reply);
      bot.sendMessage(chatId, reply);
    } catch (err) {
      console.error('Claude error:', err.message);
      const msg = err.message?.includes('429')
        ? '⏳ הגעתי למגבלת הקריאות של ה-AI. נסה שוב בעוד כמה דקות.'
        : '⚠️ שגיאה בחיבור ל-AI. נסה שוב.';
      bot.sendMessage(chatId, msg);
    }
  });

  console.log('✅ Telegram bot is running...');
  return bot;
}

module.exports = { startBot };
