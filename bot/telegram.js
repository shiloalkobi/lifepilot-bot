const TelegramBot = require('node-telegram-bot-api');
const { handleMessage } = require('./agent');
const { resetHistory } = require('./history');
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
const { buildSummaryMessage }        = require('./daily-summary');
const { buildWeeklySummaryMessage }  = require('./weekly-summary');
const {
  addReminder, deleteReminder, formatPending, formatTimeIL,
} = require('./reminders');
const { startPomo, stopPomo, statusPomo, statsPomo } = require('./pomodoro');
const { sendNews } = require('./news');
const { addSite, removeSite, load: loadSites, formatList: formatSiteList, runChecks } = require('./sites');
const { addNote, deleteNote, searchNotes, getNotesByTag, formatList: formatNoteList, load: loadNotes, fmtNote } = require('./notes');

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
        '📝 *הערות:*\n' +
        '/note [טקסט] — שמור הערה (עם תיוג AI)\n' +
        '/notes — 10 הערות אחרונות\n' +
        '/note search [מילה] — חיפוש\n' +
        '/note tag [תגית] — לפי תגית\n' +
        '/delnote [ID] — מחק הערה\n\n' +
        '🌐 /sites — סטטוס אתרים\n' +
        '/site add <url> <שם> — הוסף אתר למעקב\n' +
        '/site remove <שם> — הסר אתר\n' +
        '/site check — בדיקה מיידית\n\n' +
        '📰 /news — חדשות טכנולוגיה עכשיו\n' +
        '/news full — 10 כתבות עם קישורים\n\n' +
        '🍅 *פומודורו:*\n' +
        '/pomo — התחל סשן 25 דקות\n' +
        '/pomo 45 — סשן בהתאמה אישית\n' +
        '/pomo status — סטטוס נוכחי\n' +
        '/pomo stop — עצור\n' +
        '/pomo stats — סטטיסטיקה\n\n' +
        '⏰ *תזכורות:*\n' +
        '/remind [טקסט] — קבע תזכורת בשפה טבעית\n' +
        '/reminders — הצג תזכורות ממתינות\n' +
        '/delremind 2 — מחק תזכורת מס\' 2\n\n' +
        '📊 /summary — סיכום יומי עכשיו\n' +
        '/summary yesterday — סיכום אתמול\n' +
        '/weekly — סיכום שבועי\n\n' +
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

  // ── Notes & Snippets ─────────────────────────────────────────────────────────

  // /note <content> — save a new note
  bot.onText(/^\/note\s+(?!search|tag)(.+)$/si, async (msg, match) => {
    const content = match[1].trim();
    try {
      const note = await addNote(content);
      const tagsStr = note.tags.length ? `\n🏷️ תגיות: ${note.tags.join(', ')}` : '';
      bot.sendMessage(msg.chat.id,
        `✅ <b>הערה נשמרה #${note.id}</b>\n${note.title}${tagsStr}`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[/note] Error:', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בשמירת ההערה.');
    }
  });

  // /notes — list last 10
  bot.onText(/^\/notes$/, (msg) => {
    const notes = loadNotes().slice(-10).reverse();
    bot.sendMessage(msg.chat.id, formatNoteList(notes, `📋 <b>הערות אחרונות (${notes.length})</b>`), { parse_mode: 'HTML' });
  });

  // /note search <keyword>
  bot.onText(/^\/note\s+search\s+(.+)$/i, (msg, match) => {
    const results = searchNotes(match[1].trim());
    bot.sendMessage(msg.chat.id,
      formatNoteList(results, `🔍 <b>תוצאות עבור "${match[1].trim()}" (${results.length})</b>`),
      { parse_mode: 'HTML' }
    );
  });

  // /note tag <tag>
  bot.onText(/^\/note\s+tag\s+(.+)$/i, (msg, match) => {
    const results = getNotesByTag(match[1].trim());
    bot.sendMessage(msg.chat.id,
      formatNoteList(results, `🏷️ <b>תגית "${match[1].trim()}" (${results.length})</b>`),
      { parse_mode: 'HTML' }
    );
  });

  // /delnote <id>
  bot.onText(/^\/delnote\s+(\d+)$/, (msg, match) => {
    const id = parseInt(match[1]);
    if (deleteNote(id)) {
      bot.sendMessage(msg.chat.id, `🗑️ הערה #${id} נמחקה.`);
    } else {
      bot.sendMessage(msg.chat.id, `❌ הערה #${id} לא נמצאה.`);
    }
  });

  // ── WordPress Site Monitor ───────────────────────────────────────────────────

  // /sites — list all monitored sites
  bot.onText(/^\/sites$/, (msg) => {
    bot.sendMessage(msg.chat.id, formatSiteList(loadSites()), { parse_mode: 'HTML' });
  });

  // /site add <url> <name>
  bot.onText(/^\/site\s+add\s+(https?:\/\/\S+|\S+\.\S+)\s+(.+)$/i, (msg, match) => {
    const url  = match[1].trim();
    const name = match[2].trim();
    const res  = addSite(url, name);
    if (!res.ok) return bot.sendMessage(msg.chat.id, `⚠️ האתר כבר קיים ברשימה.`);
    bot.sendMessage(msg.chat.id, `✅ <b>${name}</b> נוסף למעקב.\n🔗 ${url}`, { parse_mode: 'HTML' });
  });

  // /site remove <name>
  bot.onText(/^\/site\s+remove\s+(.+)$/i, (msg, match) => {
    const name = match[1].trim();
    if (removeSite(name)) {
      bot.sendMessage(msg.chat.id, `🗑️ <b>${name}</b> הוסר מהמעקב.`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(msg.chat.id, `❌ לא נמצא אתר בשם "${name}".`);
    }
  });

  // /site check — force immediate check
  bot.onText(/^\/site\s+check$/i, async (msg) => {
    const sites = loadSites();
    if (sites.length === 0) return bot.sendMessage(msg.chat.id, '📭 אין אתרים במעקב.');
    await bot.sendMessage(msg.chat.id, `⏳ בודק ${sites.length} אתרים...`);
    await runChecks(bot, msg.chat.id);
    bot.sendMessage(msg.chat.id, formatSiteList(loadSites()), { parse_mode: 'HTML' });
  });

  // ── News ─────────────────────────────────────────────────────────────────────

  bot.onText(/^\/news(\s+full)?$/i, async (msg, match) => {
    const full = !!(match[1]);
    await bot.sendMessage(msg.chat.id, '📰 טוען חדשות...');
    sendNews(bot, msg.chat.id, full);
  });

  // ── Pomodoro ──────────────────────────────────────────────────────────────────

  bot.onText(/^\/pomo(?:\s+(\d+))?$/, (msg, match) => {
    const custom = match[1] ? parseInt(match[1]) : null;
    startPomo(bot, msg.chat.id, custom);
  });

  bot.onText(/^\/pomo\s+stop$/i, (msg) => stopPomo(bot, msg.chat.id));
  bot.onText(/^\/pomo\s+status$/i, (msg) => statusPomo(bot, msg.chat.id));
  bot.onText(/^\/pomo\s+stats$/i, (msg) => statsPomo(bot, msg.chat.id));

  // ── Reminders ────────────────────────────────────────────────────────────────

  // /remind <text> — parse and set a reminder
  bot.onText(/^\/remind\s+(.+)$/s, async (msg, match) => {
    const chatId = msg.chat.id;
    const text   = match[1].trim();
    try {
      await bot.sendMessage(chatId, '⏳ מפרסר תזכורת...');
      const reminder = await addReminder(chatId, text);
      if (!reminder) {
        return bot.sendMessage(chatId,
          '❌ לא הצלחתי להבין את הזמן.\n\nנסה: /remind תזכיר לי בעוד שעה לעשות X'
        );
      }
      bot.sendMessage(chatId,
        `✅ <b>תזכורת נקבעה!</b>\n\n⏰ <b>${reminder.task}</b>\n📅 ${formatTimeIL(reminder.remindAt)}`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[/remind] Error:', err.message);
      bot.sendMessage(chatId, '⚠️ שגיאה בקביעת התזכורת. נסה שוב.');
    }
  });

  // /remind with no args
  bot.onText(/^\/remind$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      '⏰ <b>קביעת תזכורת:</b>\n\n' +
      '<code>/remind תזכיר לי בעוד שעה לצלצל לרופא</code>\n' +
      '<code>/remind מחר ב-9 לשלוח מייל</code>\n' +
      '<code>/remind remind me in 30 minutes to check the oven</code>',
      { parse_mode: 'HTML' }
    );
  });

  // /reminders — list pending
  bot.onText(/^\/reminders$/, (msg) => {
    bot.sendMessage(msg.chat.id, formatPending(msg.chat.id), { parse_mode: 'HTML' });
  });

  // /delremind <n> — delete by list position or ID
  bot.onText(/^\/delremind\s+(\d+)$/, (msg, match) => {
    const chatId = msg.chat.id;
    const n      = parseInt(match[1]);
    const { listPending: lp } = require('./reminders');
    const pending = lp(chatId);

    // Try by list position first (1-based), fall back to raw ID
    const reminder = pending[n - 1] || pending.find((r) => r.id === n);
    if (!reminder) {
      return bot.sendMessage(chatId, `❌ תזכורת ${n} לא נמצאה.`);
    }
    if (deleteReminder(chatId, reminder.id)) {
      bot.sendMessage(chatId, `🗑️ תזכורת נמחקה: <b>${reminder.task}</b>`, { parse_mode: 'HTML' });
    }
  });

  // /weekly — on-demand weekly summary
  bot.onText(/^\/weekly$/, async (msg) => {
    try {
      await bot.sendMessage(msg.chat.id, '⏳ בונה סיכום שבועי...');
      const message = await buildWeeklySummaryMessage();
      bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/weekly] Error:', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בבניית הסיכום השבועי.');
    }
  });

  // /summary — on-demand daily summary; /summary yesterday for previous day
  bot.onText(/^\/summary(.*)$/, async (msg, match) => {
    const arg = (match[1] || '').trim().toLowerCase();
    const offset = (arg === 'yesterday' || arg === 'אתמול') ? -1 : 0;
    const label  = offset === -1 ? 'אתמול' : 'היום';
    try {
      await bot.sendMessage(msg.chat.id, `⏳ בונה סיכום ${label}...`, { parse_mode: 'HTML' });
      const message = await buildSummaryMessage(offset);
      bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/summary] Error:', err.message);
      bot.sendMessage(msg.chat.id, '⚠️ שגיאה בבניית הסיכום.');
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

    // ── AI Agent ─────────────────────────────────────────────────────────────
    bot.sendChatAction(chatId, 'typing');

    try {
      const reply = await handleMessage(bot, chatId, msg.text);
      console.log('[Telegram] Sending reply:', reply?.substring(0, 100));
      bot.sendMessage(chatId, reply, { parse_mode: 'HTML' })
        .catch(sendErr => console.error('[Telegram] sendMessage error:', sendErr.message));
    } catch (err) {
      console.error('[Agent] error:', err.message);
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
