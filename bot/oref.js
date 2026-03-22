'use strict';

const https = require('https');

// ── Areas to monitor (מרכז / ראשון לציון) ────────────────────────────────────
const MONITORED_AREAS = new Set([
  'ראשון לציון', 'ראשון לציון - מזרח', 'ראשון לציון - מערב',
  'תל אביב - דרום', 'תל אביב - מרכז', 'תל אביב - צפון', 'תל אביב - ירקון',
  'רמת גן', 'גבעתיים', 'פתח תקווה', 'בני ברק',
  'חולון', 'בת ים', 'רמת השרון', 'הרצליה',
  'כפר סבא', 'רעננה', 'הוד השרון', 'נס ציונה',
  'רחובות', 'לוד', 'רמלה', 'מודיעין - מכבים - רעות',
  'יהוד - מונוסון', 'גבעת שמואל', 'קריית אונו', 'אור יהודה',
  'אזור', 'ראש העין', 'אלעד',
]);

const ALERT_TYPES = {
  '1':  { emoji: '🚨',    label: 'צבע אדום — ירי רקטות וטילים',       action: 'היכנסו מיד למרחב המוגן',          shelterMin: 10 },
  '2':  { emoji: '🚀🔴', label: 'התרעה מוקדמת — טיל בליסטי מאיראן',  action: 'היכנסו מיד למרחב המוגן! ~3 דקות', shelterMin: 30 },
  '3':  { emoji: '✈️',   label: 'חדירת כטב"מ / מטוס עוין',            action: 'היכנסו למרחב המוגן',              shelterMin: 10 },
  '4':  { emoji: '🌍',   label: 'רעידת אדמה',                          action: 'צאו מהבניין בזהירות',             shelterMin: 0  },
  '6':  { emoji: '☢️',   label: 'אירוע חומרים מסוכנים',                action: 'הישארו בפנים, סגרו חלונות',       shelterMin: 0  },
  '13': { emoji: '🌊',   label: 'אזהרת צונאמי',                        action: 'התרחקו מהחוף לאלתר',             shelterMin: 0  },
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
  // Deduplication: Set of seen alert IDs (capped to prevent memory growth)
  const seenIds     = new Set();
  let shelterTimer  = null;
  let reminderTimer = null;
  let pollCount     = 0;

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

  function processAlert(raw) {
    if (!raw || raw.length < 5) return;

    let alert;
    try {
      // Strip UTF-8 BOM if present
      alert = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      return;
    }

    if (!alert.id) return;

    const alertId = String(alert.id);

    // Deduplication — skip already-seen alert IDs
    if (seenIds.has(alertId)) return;
    seenIds.add(alertId);

    // Cap Set size to prevent memory growth during long runs
    if (seenIds.size > 200) {
      const oldest = seenIds.values().next().value;
      seenIds.delete(oldest);
    }

    const cities  = Array.isArray(alert.data) ? alert.data : [];
    const matched = cities.filter((c) => MONITORED_AREAS.has(c));
    if (matched.length === 0) return;

    const cat  = String(alert.cat || '1');
    const type = ALERT_TYPES[cat] || {
      emoji: '⚠️',
      label: alert.title || 'התראה',
      action: alert.desc || 'היכנסו למרחב המוגן',
      shelterMin: 10,
    };

    const time = nowHebrew();
    const message =
      `${type.emoji} <b>${type.label}</b>\n` +
      `🕐 <b>שעה:</b> ${time}\n\n` +
      `📍 <b>אזורים:</b> ${matched.join(', ')}\n\n` +
      `🛡️ ${type.action}`;

    console.log(`[Oref] ALERT at ${time}: ${type.label} → ${matched.join(', ')}`);
    send(message);

    if (type.shelterMin > 0) startShelterCountdown(type.shelterMin);
  }

  function poll() {
    const req = https.request({
      hostname: 'www.oref.org.il',
      path: '/WarningMessages/alert/alerts.json',
      method: 'GET',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.oref.org.il/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        pollCount++;
        processAlert(data.trim());
      });
    });

    req.on('error', (err) => {
      // Log but do not crash — next poll will retry automatically
      console.error(`[Oref] Fetch error (will retry in 1s): ${err.message}`);
    });

    req.setTimeout(4000, () => {
      req.destroy();
      console.warn('[Oref] Request timeout — will retry');
    });

    req.end();
  }

  // Poll every 1 second
  setInterval(poll, 1000);
  poll();

  // Health check log every 60 seconds
  setInterval(() => {
    console.log(`[Oref] Polling active — ${pollCount} polls, ${seenIds.size} unique alerts seen`);
  }, 60 * 1000);

  console.log(`✅ [Oref] Monitor started — ${MONITORED_AREAS.size} areas | 1s polling | chat: ${chatId}`);
}

/**
 * Send a mock alert for testing the message format.
 * Call this with TEST_ALERT=1 env var.
 */
function sendMockAlert(bot, chatId) {
  const type = ALERT_TYPES['1'];
  const time = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const message =
    `${type.emoji} <b>${type.label}</b>\n` +
    `🕐 <b>שעה:</b> ${time}\n\n` +
    `📍 <b>אזורים:</b> ראשון לציון, תל אביב - מרכז\n\n` +
    `🛡️ ${type.action}\n\n` +
    `<i>⚙️ זוהי התראת בדיקה (mock)</i>`;

  console.log('[Oref] Sending mock alert for format test...');
  bot.sendMessage(chatId, message, { parse_mode: 'HTML' })
    .then(() => console.log('[Oref] Mock alert sent successfully ✅'))
    .catch((err) => console.error('[Oref] Mock alert send error:', err.message));
}

module.exports = { startOrefMonitor, sendMockAlert };
