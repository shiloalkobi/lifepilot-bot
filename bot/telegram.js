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
const {
  startCheckin, isInCheckin, processCheckinStep, cancelCheckin,
  formatTodayStatus: formatHealthToday, getWeekSummary, formatRecentLog,
} = require('./health');
const {
  getDailyWord, getRandomWord, formatWord,
  startQuiz, isInQuiz, processQuizAnswer, formatStreak,
} = require('./english');
const { formatUsage } = require('./rate-limiter');

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

  // ── Health Tracking Commands ────────────────────────────────────────────────
  bot.onText(/^\/health$/, (msg) => {
    try {
      const question = startCheckin(msg.chat.id);
      bot.sendMessage(msg.chat.id,
        '🩺 <b>דיווח בריאות יומי</b>\n' +
        'ענה על 5 שאלות קצרות. שלח /cancel בכל שלב לביטול.\n\n' + question,
        { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/health]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בהתחלת דיווח.');
    }
  });

  bot.onText(/^\/health status$/, (msg) => {
    bot.sendMessage(msg.chat.id, formatHealthToday(), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/health week$/, (msg) => {
    bot.sendMessage(msg.chat.id, getWeekSummary(7), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/health month$/, (msg) => {
    bot.sendMessage(msg.chat.id, getWeekSummary(30), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/health log$/, (msg) => {
    bot.sendMessage(msg.chat.id, formatRecentLog(5), { parse_mode: 'HTML' });
  });

  // ── English Practice Commands ───────────────────────────────────────────────
  bot.onText(/^\/english$/, async (msg) => {
    try {
      bot.sendChatAction(msg.chat.id, 'typing');
      const word = await getDailyWord();
      bot.sendMessage(msg.chat.id, formatWord(word), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/english]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בטעינת מילת היום.');
    }
  });

  bot.onText(/^\/english quiz$/, async (msg) => {
    try {
      bot.sendChatAction(msg.chat.id, 'typing');
      const q = await startQuiz(msg.chat.id);
      bot.sendMessage(msg.chat.id, q, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/english quiz]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בהתחלת quiz.');
    }
  });

  bot.onText(/^\/english random$/, (msg) => {
    try {
      const word = getRandomWord();
      bot.sendMessage(msg.chat.id, formatWord(word, '🎲 מילה אקראית'), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/english random]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/^\/english streak$/, (msg) => {
    try {
      bot.sendMessage(msg.chat.id, formatStreak(), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/english streak]', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה.');
    }
  });

  bot.onText(/^\/usage$/, (msg) => {
    bot.sendMessage(msg.chat.id, formatUsage(), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/cancel$/, (msg) => {
    if (cancelCheckin(msg.chat.id)) {
      bot.sendMessage(msg.chat.id, '❌ דיווח הבריאות בוטל.');
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

    // ── English quiz intercept ───────────────────────────────────────────────
    if (isInQuiz(chatId)) {
      try {
        const result = processQuizAnswer(chatId, msg.text);
        if (!result) return;
        await bot.sendMessage(chatId, result.reply, { parse_mode: 'HTML' });
      } catch (err) {
        console.error('[quiz]', err.message);
        bot.sendMessage(chatId, '⚠️ שגיאה. נסה שוב עם /english quiz');
      }
      return;
    }

    // ── Health check-in intercept ────────────────────────────────────────────
    if (isInCheckin(chatId)) {
      try {
        const result = processCheckinStep(chatId, msg.text);
        if (!result) return;
        await bot.sendMessage(chatId, result.reply, { parse_mode: 'HTML' });
        // After saving, check for high-pain alert
        if (result.done) {
          const { checkHighPainAlert } = require('./health');
          const alert = checkHighPainAlert();
          if (alert) setTimeout(() => bot.sendMessage(chatId, alert, { parse_mode: 'HTML' }), 1000);
        }
      } catch (err) {
        console.error('[health checkin]', err.message);
        bot.sendMessage(chatId, '⚠️ שגיאה בדיווח. נסה שוב או שלח /cancel.');
      }
      return;
    }

    // ── AI chat ──────────────────────────────────────────────────────────────
    bot.sendChatAction(chatId, 'typing');
    addMessage(chatId, 'user', msg.text);

    try {
      const reply = await askClaude(getHistory(chatId));
      addMessage(chatId, 'assistant', reply);
      bot.sendMessage(chatId, reply);
    } catch (err) {
      console.error('Claude error:', err.message);
      const errMsg = err.message?.includes('429')
        ? '⏳ הגעתי למגבלת הקריאות של ה-AI. נסה שוב בעוד כמה דקות.'
        : '⚠️ שגיאה בחיבור ל-AI. נסה שוב.';
      bot.sendMessage(chatId, errMsg);
    }
  });

  console.log('✅ Telegram bot is running...');
  return bot;
}

module.exports = { startBot };
