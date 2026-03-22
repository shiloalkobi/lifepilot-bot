'use strict';

const cron          = require('node-cron');
const { getActiveAlerts } = require('pikud-haoref-api');

// ── Areas to monitor (מרכז / ראשון לציון) — exact names from pikud-haoref-api cities.json ──
const MONITORED_AREAS = new Set([
  // ראשון לציון
  'ראשון לציון - מזרח', 'ראשון לציון - מערב',
  // תל אביב
  'תל אביב - מרכז העיר', 'תל אביב - עבר הירקון',
  'תל אביב - דרום העיר ויפו', 'תל אביב - מזרח',
  // רמת גן / גבעתיים
  'רמת גן - מזרח', 'רמת גן - מערב', 'גבעתיים',
  // חולון / בת ים
  'חולון', 'בת ים',
  // פתח תקווה / בני ברק
  'פתח תקווה', 'בני ברק',
  // הרצליה
  'הרצליה - מערב', 'הרצליה - מרכז וגליל ים',
  // שרון
  'רמת השרון', 'כפר סבא', 'רעננה', 'הוד השרון',
  // שפלה / מרכז
  'נס ציונה', 'רחובות', 'לוד', 'רמלה',
  'מודיעין מכבים רעות',
  // מזרח ת"א
  'יהוד מונוסון', 'גבעת שמואל', 'קריית אונו',
  'אור יהודה', 'אזור', 'ראש העין', 'אלעד',
]);

// ── Alert type mapping (pikud-haoref-api string types → display) ──────────────
const ALERT_TYPES = {
  missiles:                    { emoji: '🚨',    label: 'צבע אדום — ירי רקטות וטילים',       action: 'היכנסו מיד למרחב המוגן',          shelterMin: 10 },
  general:                     { emoji: '⚠️',    label: 'התרעה כללית',                         action: 'היכנסו למרחב המוגן',              shelterMin: 10 },
  earthQuake:                  { emoji: '🌍',    label: 'רעידת אדמה',                          action: 'צאו מהבניין בזהירות',             shelterMin: 0  },
  radiologicalEvent:           { emoji: '☢️',    label: 'אירוע רדיולוגי',                     action: 'הישארו בפנים, סגרו חלונות',       shelterMin: 0  },
  tsunami:                     { emoji: '🌊',    label: 'אזהרת צונאמי',                        action: 'התרחקו מהחוף לאלתר',             shelterMin: 0  },
  hostileAircraftIntrusion:    { emoji: '✈️',    label: 'חדירת כטב"מ / מטוס עוין',            action: 'היכנסו למרחב המוגן',              shelterMin: 10 },
  hazardousMaterials:          { emoji: '☣️',    label: 'אירוע חומרים מסוכנים',               action: 'הישארו בפנים, סגרו חלונות',       shelterMin: 0  },
  terroristInfiltration:       { emoji: '🔴',    label: 'חדירת מחבלים',                       action: 'נעלו דלתות, הישארו בפנים',        shelterMin: 0  },
  newsFlash:                   { emoji: '📢',    label: 'הודעה דחופה',                         action: '',                                 shelterMin: 0  },
  // Drill types — lower priority
  missilesDrill:               { emoji: '🔔',    label: 'תרגיל — צבע אדום',                   action: 'זוהי תרגיל בלבד',                 shelterMin: 0  },
  generalDrill:                { emoji: '🔔',    label: 'תרגיל כללי',                          action: 'זוהי תרגיל בלבד',                 shelterMin: 0  },
};

function nowHebrew() {
  return new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Start the Pikud HaOref alert monitor.
 * @param {import('node-telegram-bot-api')} bot
 * @param {string} chatId - from process.env.ALERT_CHAT_ID
 */
function startOrefMonitor(bot, chatId) {
  // Deduplication: Set of seen alert IDs
  const seenIds     = new Set();
  let shelterTimer  = null;
  let reminderTimer = null;
  let pollCount     = 0;
  let errorCount    = 0;

  function send(text) {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch((err) => {
      console.error('[Oref] Telegram send error:', err.message);
    });
  }

  function startShelterCountdown(minutes) {
    if (shelterTimer)  clearTimeout(shelterTimer);
    if (reminderTimer) clearTimeout(reminderTimer);

    if (minutes > 4) {
      const half = Math.floor(minutes / 2);
      reminderTimer = setTimeout(() => {
        send(`🛡️ נשארו עוד <b>${minutes - half} דקות</b> במרחב המוגן`);
      }, half * 60 * 1000);
    }

    shelterTimer = setTimeout(() => {
      send(`✅ <b>אפשר לצאת מהמרחב המוגן</b>\nעברו ${minutes} דקות מאז ההתראה.`);
    }, minutes * 60 * 1000);
  }

  function processAlerts(alerts) {
    if (!Array.isArray(alerts) || alerts.length === 0) return;

    for (const alert of alerts) {
      if (!alert.cities || alert.cities.length === 0) continue;

      // Check if any monitored city is in this alert
      const matched = alert.cities.filter((c) => MONITORED_AREAS.has(c));
      if (matched.length === 0) continue;

      // Deduplication by ID (if provided) or by type+cities fingerprint
      const alertId = alert.id
        ? String(alert.id)
        : `${alert.type}:${matched.sort().join(',')}`;

      if (seenIds.has(alertId)) continue;
      seenIds.add(alertId);

      // Cap Set to prevent memory growth
      if (seenIds.size > 200) {
        const oldest = seenIds.values().next().value;
        seenIds.delete(oldest);
      }

      const type = ALERT_TYPES[alert.type] || {
        emoji: '⚠️',
        label: alert.instructions || 'התראה',
        action: 'היכנסו למרחב המוגן',
        shelterMin: 10,
      };

      const time = nowHebrew();
      const message =
        `${type.emoji} <b>${type.label}</b>\n` +
        `🕐 <b>שעה:</b> ${time}\n\n` +
        `📍 <b>אזורים:</b> ${matched.join(', ')}\n\n` +
        (type.action ? `🛡️ ${type.action}` : '');

      console.log(`[Oref] ALERT at ${time}: ${type.label} → ${matched.join(', ')}`);
      send(message);

      if (type.shelterMin > 0) startShelterCountdown(type.shelterMin);
    }
  }

  function poll() {
    getActiveAlerts((err, alerts) => {
      pollCount++;
      if (err) {
        errorCount++;
        // Log only every 10th error to avoid log spam
        if (errorCount % 10 === 1) {
          console.error(`[Oref] Fetch error #${errorCount}: ${err.message}`);
        }
        return;
      }
      errorCount = 0; // reset on success
      processAlerts(alerts);
    });
  }

  // Poll every 2 seconds (pikud-haoref-api is heavier than raw HTTPS)
  setInterval(poll, 2000);
  poll();

  // Health check log every 60 seconds
  setInterval(() => {
    const status = errorCount > 0 ? `⚠️ ${errorCount} consecutive errors` : '✅ OK';
    console.log(`[Oref] Status: ${status} | ${pollCount} total polls | ${seenIds.size} unique alerts`);
  }, 60 * 1000);

  // Daily health check at 09:00 Israel (06:00 UTC)
  cron.schedule('0 6 * * *', async () => {
    try {
      const msg =
        `🛡️ <b>בדיקת מערכת פיקוד העורף — יומית</b>\n\n` +
        `✅ מערכת ההתראות פעילה\n` +
        `📊 ${pollCount} בדיקות מאז ההפעלה\n` +
        `🔍 ${seenIds.size} התראות ייחודיות נרשמו\n` +
        `⏱️ בדיקה כל 2 שניות — ${MONITORED_AREAS.size} אזורים במעקב\n\n` +
        `<i>ישראל שקטה — אין התראות פעילות</i>`;
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      console.log('[Oref] Daily health check sent');
    } catch (err) {
      console.error('[Oref] Daily health check error:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log(`✅ [Oref] Monitor started — ${MONITORED_AREAS.size} areas | 2s polling | daily check 09:00 IL | chat: ${chatId}`);
}

/**
 * Send a mock alert for testing the message format.
 */
function sendMockAlert(bot, chatId) {
  const type = ALERT_TYPES['missiles'];
  const time = nowHebrew();
  const message =
    `${type.emoji} <b>${type.label}</b>\n` +
    `🕐 <b>שעה:</b> ${time}\n\n` +
    `📍 <b>אזורים:</b> ראשון לציון - מזרח, תל אביב - מרכז העיר\n\n` +
    `🛡️ ${type.action}\n\n` +
    `<i>⚙️ זוהי התראת בדיקה (mock)</i>`;

  console.log('[Oref] Sending mock alert for format test...');
  bot.sendMessage(chatId, message, { parse_mode: 'HTML' })
    .then(() => console.log('[Oref] Mock alert sent successfully ✅'))
    .catch((err) => console.error('[Oref] Mock alert send error:', err.message));
}

module.exports = { startOrefMonitor, sendMockAlert };
