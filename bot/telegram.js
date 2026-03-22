const TelegramBot = require('node-telegram-bot-api');
const { askClaude } = require('./claude');
const { getHistory, addMessage, resetHistory } = require('./history');
const { buildMorningMessage } = require('./scheduler');
const {
  addTask, markDone, markUndone, deleteTask,
  clearCompleted, formatOpenTasks,
} = require('./tasks');

function startBot(token) {
  const bot = new TelegramBot(token, {
    polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
  });

  // Handle polling errors gracefully — 409 means another instance is running.
  // Stop polling, wait 5s, restart so only one instance wins.
  bot.on('polling_error', (err) => {
    console.error('[polling_error]', err.message);
    if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
      console.warn('[Bot] 409 Conflict — another instance running. Restarting polling in 5s...');
      bot.stopPolling().then(() => {
        setTimeout(() => {
          bot.startPolling();
          console.log('[Bot] Polling restarted.');
        }, 5000);
      }).catch(() => {});
    }
  });

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
      '📋 *פקודות זמינות:*\n\n' +
        '🌅 /boker — הודעת בוקר טוב\n\n' +
        '✅ *משימות:*\n' +
        '/task טקסט — הוסף משימה\n' +
        '/task !טקסט — הוסף משימה דחופה\n' +
        '/tasks — הצג משימות פתוחות\n' +
        '/done 2 — סמן משימה 2 כבוצעת\n' +
        '/undone 2 — פתח מחדש משימה 2\n' +
        '/deltask 2 — מחק משימה 2\n' +
        '/cleartasks — מחק כל הבוצעות\n\n' +
        '⚙️ /reset — מחיקת היסטוריית שיחה\n' +
        '/help — עזרה\n\n' +
        'כל הודעה אחרת → Gemini AI',
      { parse_mode: 'Markdown' }
    );
  });

  // ── Task Management Commands ────────────────────────────────────────────────
  bot.onText(/^\/task (.+)/, (msg, match) => {
    try {
      const task = addTask(match[1].trim());
      if (!task) return bot.sendMessage(msg.chat.id, '⚠️ טקסט המשימה ריק.');
      const emoji = task.priority === 'high' ? '📌' : '🔲';
      const note  = task.priority === 'high' ? ' <b>[דחוף]</b>' : '';
      bot.sendMessage(msg.chat.id,
        `${emoji} <b>משימה נוספה!</b>\n${task.text}${note}`,
        { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/task]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בהוספת המשימה.');
    }
  });

  bot.onText(/^\/tasks$/, (msg) => {
    try {
      bot.sendMessage(msg.chat.id, formatOpenTasks(), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/tasks]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בטעינת המשימות.');
    }
  });

  bot.onText(/^\/done (\d+)$/, (msg, match) => {
    try {
      const task = markDone(parseInt(match[1]));
      if (!task) return bot.sendMessage(msg.chat.id, '⚠️ מספר משימה לא נמצא.');
      bot.sendMessage(msg.chat.id,
        `✅ <b>בוצע!</b>\n${task.text}`,
        { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/done]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בסימון המשימה.');
    }
  });

  bot.onText(/^\/undone (\d+)$/, (msg, match) => {
    try {
      const task = markUndone(parseInt(match[1]));
      if (!task) return bot.sendMessage(msg.chat.id, '⚠️ מספר משימה לא נמצא.');
      bot.sendMessage(msg.chat.id,
        `🔲 <b>נפתח מחדש:</b>\n${task.text}`,
        { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/undone]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/^\/deltask (\d+)$/, (msg, match) => {
    try {
      const task = deleteTask(parseInt(match[1]));
      if (!task) return bot.sendMessage(msg.chat.id, '⚠️ מספר משימה לא נמצא.');
      bot.sendMessage(msg.chat.id, `🗑️ נמחק: ${task.text}`);
    } catch (err) {
      console.error('[/deltask]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה במחיקת המשימה.');
    }
  });

  bot.onText(/^\/cleartasks$/, (msg) => {
    try {
      const count = clearCompleted();
      bot.sendMessage(msg.chat.id,
        count > 0 ? `🧹 נמחקו ${count} משימות שהושלמו.` : '📋 אין משימות שהושלמו למחיקה.');
    } catch (err) {
      console.error('[/cleartasks]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/\/boker/, async (msg) => {
    try {
      const message = await buildMorningMessage();
      bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/boker] Error:', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בטעינת הודעת הבוקר.');
    }
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
