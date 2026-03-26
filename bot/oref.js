'use strict';

const https = require('https');
const cron  = require('node-cron');

// ── Areas to monitor (מרכז / ראשון לציון) — exact names from tzevaadom cities.json ──
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

// ── Tzofar (tzevaadom.co.il) threat ID → display info ─────────────────────────
// Source: https://github.com/dn5qMDW3/tzevaadom/blob/main/custom_components/tzevaadom/const.py
const THREAT_TYPES = {
  0: { emoji: '🚨',    label: 'צבע אדום — ירי רקטות וטילים',        action: 'היכנסו מיד למרחב המוגן',          shelterMin: 10 },
  1: { emoji: '☣️',    label: 'אירוע חומרים מסוכנים',                action: 'הישארו בפנים, סגרו חלונות',       shelterMin: 0  },
  2: { emoji: '🔴',    label: 'חדירת מחבלים',                        action: 'נעלו דלתות, הישארו בפנים',        shelterMin: 0  },
  3: { emoji: '🌍',    label: 'רעידת אדמה',                          action: 'צאו מהבניין בזהירות',             shelterMin: 0  },
  4: { emoji: '🌊',    label: 'אזהרת צונאמי',                        action: 'התרחקו מהחוף לאלתר',             shelterMin: 0  },
  5: { emoji: '✈️',    label: 'חדירת כטב"מ / מטוס עוין',             action: 'היכנסו למרחב המוגן',              shelterMin: 10 },
  6: { emoji: '☢️',    label: 'אירוע רדיולוגי',                      action: 'הישארו בפנים, סגרו חלונות',       shelterMin: 0  },
  7: { emoji: '🚀🔴',  label: 'ירי טיל בליסטי',                      action: 'היכנסו מיד למרחב המוגן! ~3 דקות', shelterMin: 30 },
  8: { emoji: '📢',    label: 'התרעה — הודעת פיקוד העורף',           action: '',                                 shelterMin: 0  },
  9: { emoji: '🔔',    label: 'תרגיל פיקוד העורף',                   action: 'זוהי תרגיל בלבד',                 shelterMin: 0  },
};

function nowHebrew() {
  return new Date().toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ── HTTP GET helper ────────────────────────────────────────────────────────────
function httpGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Primary source: api.tzevaadom.co.il (no geo-blocking, worldwide) ──────────
async function fetchTzofar() {
  const { status, body } = await httpGet('api.tzevaadom.co.il', '/notifications');
  if (status !== 200) throw new Error(`Tzofar returned HTTP ${status}`);
  const data = JSON.parse(body);
  if (!Array.isArray(data)) throw new Error('Tzofar: unexpected response format');
  // Each notification: { notificationId, threat, isDrill, cities: [string], time }
  return data;
}

// ── Secondary source: oref.org.il (geo-blocked from US, may work or not) ──────
async function fetchOref() {
  const { status, body } = await httpGet('www.oref.org.il', '/WarningMessages/alert/alerts.json', {
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://www.oref.org.il/',
  });
  if (status !== 200) throw new Error(`Oref returned HTTP ${status}`);
  const cleaned = body.replace(/^\uFEFF/, '').trim();
  if (!cleaned || cleaned === '\r\n') return []; // empty = no alerts
  const json = JSON.parse(cleaned);
  if (!json.data || !Array.isArray(json.data)) return [];
  // Convert to tzofar-like format for uniform processing
  return [{ notificationId: String(json.id || Date.now()), threat: Number(json.cat || 1) - 1, isDrill: false, cities: json.data }];
}

/**
 * Start the Pikud HaOref alert monitor.
 * Primary: api.tzevaadom.co.il (Cloudflare, no geo-blocking)
 * Fallback: www.oref.org.il (may be geo-blocked from US)
 */
function startOrefMonitor(bot, chatId) {
  const seenIds     = new Set();
  let shelterTimer  = null;
  let reminderTimer = null;
  let pollCount     = 0;
  let primaryErrors = 0;
  let source        = 'tzofar'; // track which source is active

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

  function processNotifications(notifications) {
    if (!notifications || notifications.length === 0) return;

    for (const n of notifications) {
      const cities = Array.isArray(n.cities) ? n.cities : [];
      const matched = cities.filter((c) => MONITORED_AREAS.has(c));
      if (matched.length === 0) continue;

      // Skip drills (threat 9 or isDrill=true)
      if (n.isDrill || n.threat === 9) continue;

      const alertId = String(n.notificationId || `${n.threat}:${matched.sort().join(',')}`);
      if (seenIds.has(alertId)) continue;
      seenIds.add(alertId);

      if (seenIds.size > 200) {
        seenIds.delete(seenIds.values().next().value);
      }

      const type = THREAT_TYPES[n.threat] || {
        emoji: '⚠️', label: 'התרעה', action: 'היכנסו למרחב המוגן', shelterMin: 10,
      };

      const time    = nowHebrew();
      const message =
        `${type.emoji} <b>${type.label}</b>\n` +
        `🕐 <b>שעה:</b> ${time}\n\n` +
        `📍 <b>אזורים:</b> ${matched.join(', ')}\n\n` +
        (type.action ? `🛡️ ${type.action}` : '');

      console.log(`[Oref] ALERT [${source}] ${time}: ${type.label} → ${matched.join(', ')}`);
      send(message);

      if (type.shelterMin > 0) startShelterCountdown(type.shelterMin);
    }
  }

  async function poll() {
    pollCount++;
    try {
      // Try primary (Tzofar — no geo-blocking)
      const notifications = await fetchTzofar();
      primaryErrors = 0;
      source = 'tzofar';
      processNotifications(notifications);
    } catch (tzErr) {
      primaryErrors++;
      if (primaryErrors % 30 === 1) {
        console.error(`[Oref] Tzofar error #${primaryErrors}: ${tzErr.message} — trying Oref fallback`);
      }
      // Fallback to oref.org.il
      try {
        const notifications = await fetchOref();
        source = 'oref';
        processNotifications(notifications);
      } catch (orefErr) {
        if (primaryErrors % 30 === 1) {
          console.error(`[Oref] Oref fallback also failed: ${orefErr.message}`);
        }
      }
    }
  }

  // Poll every 2 seconds
  setInterval(poll, 2000);
  poll();

  // Health check log every 10 minutes
  setInterval(() => {
    const errNote = primaryErrors > 0 ? ` | Tzofar errors: ${primaryErrors}` : '';
    console.log(`[Oref] Status: source=${source} | polls=${pollCount} | seen=${seenIds.size}${errNote}`);
  }, 10 * 60 * 1000);

  // Daily health check at 09:00 Israel (06:00 UTC)
  cron.schedule('0 6 * * *', async () => {
    try {
      const srcLabel = source === 'tzofar'
        ? '✅ Tzofar (tzevaadom.co.il) — ללא geo-blocking'
        : '⚠️ Oref ישיר — עלול להיחסם';
      const msg =
        `🛡️ <b>בדיקת מערכת פיקוד העורף — יומית</b>\n\n` +
        `${srcLabel}\n` +
        `📊 ${pollCount} בדיקות | ${seenIds.size} התראות ייחודיות\n` +
        `⏱️ בדיקה כל 2 שניות | ${MONITORED_AREAS.size} אזורים במעקב\n\n` +
        `<i>ישראל שקטה — אין התראות פעילות</i>`;
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      console.log('[Oref] Daily health check sent');
    } catch (err) {
      console.error('[Oref] Daily health check error:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log(`✅ [Oref] Monitor started — Tzofar primary + Oref fallback | ${MONITORED_AREAS.size} areas | chat: ${chatId}`);
}

/**
 * Send a mock alert for testing message format.
 */
function sendMockAlert(bot, chatId) {
  const type = THREAT_TYPES[0];
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
