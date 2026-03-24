'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const DATA_FILE   = path.join(__dirname, '..', 'data', 'sites.json');
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TIMEOUT_MS  = 10000;

// ── Storage ───────────────────────────────────────────────────────────────────

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function save(sites) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(sites, null, 2), 'utf8');
}

// ── HTTP check ────────────────────────────────────────────────────────────────

function checkSite(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const start = Date.now();
    try {
      const req = mod.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'LifePilot-Monitor/1.0' } }, (res) => {
        res.resume(); // drain
        resolve({ status: res.statusCode, ms: Date.now() - start });
      });
      req.on('error', () => resolve({ status: 0, ms: Date.now() - start }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: TIMEOUT_MS }); });
    } catch {
      resolve({ status: 0, ms: Date.now() - start });
    }
  });
}

// ── Formatting ────────────────────────────────────────────────────────────────

function statusIcon(site) {
  if (site.lastStatus === null) return '⬜';
  return site.lastStatus === 200 ? '🟢' : '🔴';
}

function fmtChecked(iso) {
  if (!iso) return 'לא נבדק';
  return new Date(iso).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
}

function formatList(sites) {
  if (sites.length === 0) {
    return '📭 אין אתרים במעקב.\n\n/site add https://example.com שם — להוסיף אתר';
  }
  const lines = sites.map((s, i) => {
    const icon   = statusIcon(s);
    const code   = s.lastStatus ? ` (${s.lastStatus})` : '';
    const when   = fmtChecked(s.lastChecked);
    return `${icon} ${i + 1}. <b>${s.name}</b>${code}\n   🔗 ${s.url}\n   ⏱️ נבדק: ${when}`;
  });
  return `🌐 <b>אתרים במעקב (${sites.length})</b>\n\n${lines.join('\n\n')}`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function addSite(url, name) {
  if (!url.startsWith('http')) url = 'https://' + url;
  const sites = load();
  if (sites.find((s) => s.url === url)) return { ok: false, reason: 'exists' };
  sites.push({ url, name, lastStatus: null, lastChecked: null, lastDownAt: null });
  save(sites);
  return { ok: true };
}

function removeSite(nameOrUrl) {
  const sites = load();
  const idx   = sites.findIndex(
    (s) => s.name === nameOrUrl || s.url === nameOrUrl || s.name.includes(nameOrUrl)
  );
  if (idx === -1) return false;
  sites.splice(idx, 1);
  save(sites);
  return true;
}

// ── Monitor ───────────────────────────────────────────────────────────────────

async function runChecks(bot, alertChatId) {
  const sites  = load();
  if (sites.length === 0) return;
  let changed  = false;

  await Promise.all(sites.map(async (site) => {
    const { status } = await checkSite(site.url);
    const wasUp   = site.lastStatus === 200;
    const isUp    = status === 200;
    const wasNull = site.lastStatus === null;

    site.lastChecked = new Date().toISOString();

    if (!wasNull && wasUp && !isUp) {
      // went down
      site.lastDownAt = new Date().toISOString();
      bot.sendMessage(alertChatId,
        `🔴 <b>${site.name}</b> לא מגיב!\nסטטוס: ${status || 'timeout'}\n🔗 ${site.url}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      console.log(`[Sites] DOWN: ${site.name} (${status})`);
    } else if (!wasNull && !wasUp && isUp) {
      // came back up
      const downMins = site.lastDownAt
        ? Math.round((Date.now() - new Date(site.lastDownAt)) / 60000)
        : '?';
      bot.sendMessage(alertChatId,
        `🟢 <b>${site.name}</b> חזר לעבוד!\nהיה למטה ${downMins} דקות`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      site.lastDownAt = null;
      console.log(`[Sites] UP: ${site.name} (was down ${downMins}m)`);
    }

    site.lastStatus = status;
    changed = true;
  }));

  if (changed) save(sites);
}

function startSiteMonitor(bot, alertChatId) {
  const sites = load();
  console.log(`✅ [Sites] Monitor started — ${sites.length} sites | 5 min interval`);
  runChecks(bot, alertChatId);
  setInterval(() => runChecks(bot, alertChatId), CHECK_INTERVAL_MS);
}

module.exports = { addSite, removeSite, load, formatList, runChecks, startSiteMonitor };
