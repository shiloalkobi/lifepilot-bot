const TelegramBot = require('node-telegram-bot-api');
const { askClaude } = require('./claude');
const { getHistory, addMessage, resetHistory } = require('./history');
const { buildMorningMessage } = require('./scheduler');
const {
  addTask, markDone, markUndone, deleteTask,
  clearCompleted, formatOpenTasks,
} = require('./tasks');
const {
  addMedication, removeMedication, markTaken, markSkipped,
  formatList: formatMedList, formatTodayStatus,
} = require('./medications');

function startBot(token, webhookUrl = null) {
  let bot;

  if (webhookUrl) {
    // ── Webhook mode (Render) ─────────────────────────────────────────────────
    // No polling — Telegram pushes updates to our HTTP server.
    // processUpdate() is called from index.js for each incoming POST.
    bot = new TelegramBot(token);
    bot.setWebHook(webhookUrl)
      .then(() => console.log(`[Bot] Webhook set → ${webhookUrl}`))
      .catch((err) => console.error('[Bot] setWebHook error:', err.message));
    console.log('[Bot] Running in webhook mode');
  } else {
    // ── Polling mode (local dev) ──────────────────────────────────────────────
    bot = new TelegramBot(token, {
      polling: { interval: 300, autoStart: true, params: { timeout: 10 } },
    });
    // First clear any lingering webhook so polling works
    bot.deleteWebHook().catch(() => {});
    console.log('[Bot] Running in polling mode');

    bot.on('polling_error', (err) => {
      console.error('[polling_error]', err.message);
      if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
        console.warn('[Bot] 409 Conflict — another instance running. Restarting polling in 5s...');
        bot.stopPolling().then(() => {
          setTimeout(() => { bot.startPolling(); console.log('[Bot] Polling restarted.'); }, 5000);
        }).catch(() => {});
      }
    });
  }

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

  // ── Medication Commands ─────────────────────────────────────────────────────
  bot.onText(/^\/med add (.+?) (\S+)$/, (msg, match) => {
    try {
      const result = addMedication(match[1].trim(), match[2].trim());
      if (result.error) return bot.sendMessage(msg.chat.id, `⚠️ ${result.error}`);
      const { med } = result;
      bot.sendMessage(msg.chat.id,
        `💊 <b>תרופה נוספה!</b>\n` +
        `<b>${med.name}</b>${med.dosage ? ` — ${med.dosage}` : ''}\n` +
        `🕐 מועדים: ${med.times.join(', ')}`,
        { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/med add]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בהוספת תרופה.\nשימוש: /med add שם HH:MM,HH:MM');
    }
  });

  bot.onText(/^\/med list$/, (msg) => {
    try {
      bot.sendMessage(msg.chat.id, formatMedList(), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/med list]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/^\/med taken (.+)$/, (msg, match) => {
    try {
      const result = markTaken(match[1].trim());
      if (!result) return bot.sendMessage(msg.chat.id, '⚠️ תרופה לא נמצאה. בדוק /med list');
      bot.sendMessage(msg.chat.id,
        `✅ <b>רשום!</b> ${result.med.name} נלקח ב-${result.time}`,
        { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/med taken]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/^\/med skip (.+)$/, (msg, match) => {
    try {
      const result = markSkipped(match[1].trim());
      if (!result) return bot.sendMessage(msg.chat.id, '⚠️ תרופה לא נמצאה. בדוק /med list');
      bot.sendMessage(msg.chat.id,
        `⏭️ <b>דולג:</b> ${result.med.name} (${result.time})`,
        { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/med skip]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/^\/med remove (.+)$/, (msg, match) => {
    try {
      const removed = removeMedication(match[1].trim());
      if (!removed) return bot.sendMessage(msg.chat.id, '⚠️ תרופה לא נמצאה.');
      bot.sendMessage(msg.chat.id, `🗑️ הוסר: ${removed.name}`);
    } catch (err) {
      console.error('[/med remove]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/^\/med status$/, (msg) => {
    try {
      bot.sendMessage(msg.chat.id, formatTodayStatus(), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/med status]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/^\/med$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '💊 <b>פקודות תרופות:</b>\n\n' +
      '/med add שם HH:MM,HH:MM — הוסף תרופה\n' +
      '/med list — הצג כל התרופות\n' +
      '/med status — סטטוס היום\n' +
      '/med taken שם — סמן כנלקח\n' +
      '/med skip שם — סמן כדולג\n' +
      '/med remove שם — הסר תרופה',
      { parse_mode: 'HTML' });
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
