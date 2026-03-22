'use strict';

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

function timestamp() {
  return new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

/**
 * Start the Pikud HaOref alert monitor.
 * @param {import('node-telegram-bot-api')} bot - Telegram bot instance
 * @param {string} chatId - Chat ID to send alerts to
 */
function startOrefMonitor(bot, chatId) {
  const https = require('https');
  let lastAlertId  = null;
  let shelterTimer  = null;
  let reminderTimer = null;

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
    try { alert = JSON.parse(raw); } catch { return; }
    if (!alert.id || alert.id === lastAlertId) return;
    lastAlertId = alert.id;

    const cities = Array.isArray(alert.data) ? alert.data : [];
    const matched = cities.filter((c) => MONITORED_AREAS.has(c));
    if (matched.length === 0) return;

    const cat  = String(alert.cat || '1');
    const type = ALERT_TYPES[cat] || { emoji: '⚠️', label: alert.title || 'התראה', action: alert.desc || '', shelterMin: 10 };

    const message =
      `${type.emoji} <b>${type.label}</b>\n\n` +
      `📍 <b>אזורים:</b> ${matched.join(', ')}\n\n` +
      `🛡️ ${type.action}`;

    console.log(`[${timestamp()}] [Oref] Alert: ${type.label} → ${matched.join(', ')}`);
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
        'User-Agent': 'Mozilla/5.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { processAlert(data.trim()); });
    });
    req.on('error', (err) => console.error('[Oref] fetch error:', err.message));
    req.setTimeout(4000, () => { req.destroy(); });
    req.end();
  }

  // Poll every 1 second for near-real-time alerts
  setInterval(poll, 1000);
  poll();

  console.log(`✅ [Oref] Alert monitor running — watching ${MONITORED_AREAS.size} areas (1s polling)`);
}

module.exports = { startOrefMonitor };
