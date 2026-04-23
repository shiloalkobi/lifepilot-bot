require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const fs   = require('fs');

process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err?.message || err);
});

const http = require('http');
const cron = require('node-cron');
const { startBot }                  = require('./telegram');
const { startOrefMonitor, sendMockAlert } = require('./oref');
const { startProactiveScheduler }   = require('./proactive');
const { startScheduler }            = require('./scheduler');
const { scheduleMedications }       = require('./medications');
const { startReminderScheduler }    = require('./reminders');
const { startSiteMonitor }          = require('./sites');
const {
  createToken, verifyToken, deleteToken,
  isOwner, extractToken, requireAuth,
} = require('./auth');
const { getMetricsHistory } = require('./metrics-history');
const { supabase: supaClient, isEnabled: supaEnabled } = require('./supabase');
const { performBackup, listBackups, getBackup, cleanupOldBackups } = require('./backup');

const token       = process.env.TELEGRAM_BOT_TOKEN;
const apiKey      = process.env.GROQ_API_KEY;
const alertChatId = process.env.ALERT_CHAT_ID;
const renderUrl   = process.env.RENDER_EXTERNAL_URL;
const cronSecret  = process.env.CRON_SECRET; // protect /cron/* endpoints

if (!token) { console.error('❌ Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }
if (!apiKey) { console.error('❌ Missing GROQ_API_KEY');        process.exit(1); }

if (!process.env.TELEGRAM_CHAT_ID) {
  console.error('⚠️  TELEGRAM_CHAT_ID not set — dashboard auth disabled!');
} else {
  console.log(`[Auth] Owner chat ID: ${process.env.TELEGRAM_CHAT_ID}`);
}

// ── Webhook vs polling ────────────────────────────────────────────────────────
const webhookUrl = renderUrl ? `${renderUrl}/bot${token}` : null;
const bot = startBot(token, webhookUrl);

// ── Scheduler ─────────────────────────────────────────────────────────────────
const mainChatId = alertChatId || process.env.CHAT_ID;
let cronActions  = null; // populated below

if (mainChatId) {
  cronActions = startScheduler(bot, mainChatId);
  scheduleMedications(bot, mainChatId);
}

startReminderScheduler(bot);

// ── Rate limiter alert hook ───────────────────────────────────────────────────
{
  const { setAlertFn } = require('./rate-limiter');
  const alertTarget = process.env.TELEGRAM_CHAT_ID || mainChatId;
  if (alertTarget) {
    setAlertFn((msg) => bot.sendMessage(alertTarget, msg, { parse_mode: 'HTML' }));
  }
}

// ── Proactive scheduler (Shabbat + morning + health reminder) ─────────────────
{
  const proactiveChatId = process.env.TELEGRAM_CHAT_ID || mainChatId;
  if (proactiveChatId) {
    startProactiveScheduler(bot, proactiveChatId);
  } else {
    console.warn('[Proactive] TELEGRAM_CHAT_ID not set — scheduler disabled');
  }
}

// ── Daily automatic backup (03:00 IL) + weekly cleanup (Sun 02:00 IL) ────────
{
  const backupChatId = process.env.TELEGRAM_CHAT_ID || mainChatId;

  cron.schedule('0 3 * * *', async () => {
    try {
      const result = await performBackup('auto');
      if (!backupChatId) return;
      if (result.success && !result.skipped) {
        const mb = (result.size / 1024 / 1024).toFixed(2);
        bot.sendMessage(
          backupChatId,
          `✅ <b>גיבוי יומי הושלם</b>\n\n` +
          `📦 ${result.recordCount} רשומות • ${mb} MB\n` +
          `⏱️ ${result.durationMs}ms\n` +
          `🆔 <code>${result.id}</code>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      } else if (!result.success) {
        bot.sendMessage(
          backupChatId,
          `⚠️ <b>גיבוי יומי נכשל</b>\n\n${result.error || 'שגיאה לא ידועה'}\n\nמנסה שוב בעוד 5 דקות...`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        setTimeout(async () => {
          try {
            const retry = await performBackup('auto');
            if (retry.success && !retry.skipped) {
              const mb = (retry.size / 1024 / 1024).toFixed(2);
              bot.sendMessage(
                backupChatId,
                `✅ <b>גיבוי הצליח בניסיון השני</b>\n\n📦 ${retry.recordCount} רשומות • ${mb} MB`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            } else if (!retry.success) {
              bot.sendMessage(
                backupChatId,
                `❌ <b>גיבוי נכשל שוב</b>\n\n${retry.error || 'שגיאה'}\n\nבדוק את הלוגים.`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          } catch (e) {
            console.error('[Backup] Retry crashed:', e.message);
          }
        }, 5 * 60 * 1000);
      }
    } catch (e) {
      console.error('[Backup] Daily cron crashed:', e.message);
    }
  }, { timezone: 'Asia/Jerusalem' });

  cron.schedule('0 2 * * 0', async () => {
    try { await cleanupOldBackups(); }
    catch (e) { console.error('[Backup] Cleanup crashed:', e.message); }
  }, { timezone: 'Asia/Jerusalem' });

  console.log('[Backup] Daily 03:00 IL + weekly cleanup Sun 02:00 IL scheduled');
}

// ── AI News cron removed — covered by scheduler.js 12:00 full news send ──────

// ── WordPress / Site Monitor ──────────────────────────────────────────────────
startSiteMonitor(bot, mainChatId || alertChatId);

// ── Pikud HaOref ──────────────────────────────────────────────────────────────
if (alertChatId) {
  startOrefMonitor(bot, alertChatId);
  if (process.env.TEST_ALERT === '1') {
    setTimeout(() => sendMockAlert(bot, alertChatId), 2000);
  }
} else {
  console.warn('⚠️ ALERT_CHAT_ID not set — Oref alerts disabled');
}

// ── "Sent today" deduplication ────────────────────────────────────────────────
// In-memory flags — reset at midnight IL
const sentToday = { morning: null, english: null, news: null, summary: null, weekly: null };

function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function alreadySentToday(key) {
  return sentToday[key] === todayIL();
}

function markSentToday(key) {
  sentToday[key] = todayIL();
}

// ── Response helpers ──────────────────────────────────────────────────────────
// Keep responses TINY — cron-job.org has a strict response-size limit.
// No Content-Type, no Date (disabled on server), Connection: close (no Keep-Alive header).
const OK_BODY = '{"ok":true}';
const OK_LEN  = String(Buffer.byteLength(OK_BODY)); // '11'

function respondOk(res) {
  res.sendDate = false; // belt-and-suspenders alongside server.sendDate = false
  res.writeHead(200, { 'Content-Length': OK_LEN, 'Connection': 'close' });
  res.end(OK_BODY);
}

function respondErr(res, code, msg) {
  const body = `{"ok":false,"e":"${msg}"}`;
  res.sendDate = false;
  res.writeHead(code, { 'Content-Length': String(Buffer.byteLength(body)), 'Connection': 'close' });
  res.end(body);
}

// ── Cron endpoint handler ─────────────────────────────────────────────────────
// Pattern: respond {"ok":true} immediately, do heavy work async after.
// Mark dedup BEFORE responding to prevent double-fire on concurrent requests.
function handleCronRoute(route, res) {
  if (!mainChatId || !cronActions) return respondErr(res, 503, 'not_configured');

  const ACTIONS = {
    '/cron/morning': ['morning', () => cronActions.sendMorning()],
    '/cron/english': ['english', () => cronActions.sendEnglishWord()],
    '/cron/news':    ['news',    () => cronActions.sendDailyNews()],
    '/cron/summary': ['summary', () => cronActions.sendDailySummary()],
    '/cron/weekly':  ['weekly',  () => cronActions.sendWeeklySummary()],
  };

  const entry = ACTIONS[route];
  if (entry) {
    const [key, fn] = entry;
    if (alreadySentToday(key)) return respondOk(res); // already done today
    markSentToday(key);   // mark first — prevents double-fire
    respondOk(res);       // respond immediately (tiny body, no timeout)
    fn().catch((err) => { // do the real work async, after HTTP response is sent
      console.error(`[Cron] ${route} async error:`, err.message);
    });
    return;
  }

  if (route === '/cron/health') {
    const { getUsage } = require('./rate-limiter');
    const u    = getUsage();
    const body = `{"ok":true,"up":${Math.round(process.uptime())},"sent":${JSON.stringify(sentToday)},"rl":${JSON.stringify(u)}}`;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  respondErr(res, 404, 'not_found');
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const urlObj  = new URL(req.url, `http://localhost`);
  const route   = urlObj.pathname;
  const keyParam = urlObj.searchParams.get('key');

  // Webhook endpoint
  if (webhookUrl && req.method === 'POST' && route === `/bot${token}`) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { bot.processUpdate(JSON.parse(body)); } catch (err) {
        console.error('[Webhook] processUpdate error:', err.message);
      }
      res.writeHead(200, { 'Content-Length': '2' });
      res.end('OK');
    });
    return;
  }

  // Cron endpoints — require secret key
  if (route.startsWith('/cron/')) {
    if (cronSecret && keyParam !== cronSecret) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
      return;
    }
    handleCronRoute(route, res);
    return;
  }

  // Serve generated forms / landing pages from public/forms/
  if (req.method === 'GET' && route.startsWith('/forms/')) {
    const formFile = route.slice('/forms/'.length).replace(/\.\./g, ''); // strip path traversal
    if (!formFile || !formFile.endsWith('.html')) { res.writeHead(400); res.end('Bad request'); return; }
    const formFilePath = path.join(__dirname, '..', 'public', 'forms', formFile);
    try {
      const html = fs.readFileSync(formFilePath, 'utf8');
      const buf  = Buffer.from(html, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    } catch (e) {
      res.writeHead(404); res.end('Form not found');
    }
    return;
  }

  // Dashboard HTML — protected
  if (req.method === 'GET' && route === '/dashboard') {
    return requireAuth(req, res, async () => {
      const queryToken = urlObj.searchParams.get('token');

      // If token came via query string, set cookie and redirect to clean URL
      if (queryToken) {
        const isProd = process.env.NODE_ENV === 'production'
                    || process.env.RENDER === 'true'
                    || !!renderUrl;
        const cookieFlags = [
          `dashboard_token=${queryToken}`,
          `Max-Age=${24 * 60 * 60}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Strict',
        ];
        if (isProd) cookieFlags.push('Secure');

        res.setHeader('Set-Cookie', cookieFlags.join('; '));
        res.statusCode = 302;
        res.setHeader('Location', '/dashboard');
        res.end();
        return;
      }

      // Serve dashboard HTML
      try {
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
        const buf  = Buffer.from(html, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
        res.end(buf);
      } catch (e) {
        res.writeHead(500); res.end('Error: ' + e.message);
      }
    }, true); // onDenyHtml = true
  }

  // Dashboard API — returns JSON for the dashboard page (protected)
  if (req.method === 'GET' && route === '/api/dashboard') {
    return requireAuth(req, res, async () => {
      try {
        const { getTodayHealth, load: loadAllHealth } = require('./health');
        const { getHabits }             = require('./habits');
        const { getMonthlyExpenses, getExpenses } = require('./expenses');
        const { getOpenTasks, getCompletedToday } = require('./tasks');
        const { loadTasks } = require('./tasks');
        const { getWatchlistForChat, fetchStockPrice } = require('./stocks');
        const { isEnabled: supabaseEnabled } = require('./supabase');

        const chatId = process.env.TELEGRAM_CHAT_ID || mainChatId || '';
        const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

        // Health today
        const h = await getTodayHealth();
        const health = h ? { pain: h.painLevel, mood: h.mood, sleep: h.sleep } : null;

        // Health history — last 30 days (pain chart) + 7-day summary
        let allHealth = [];
        try { allHealth = await loadAllHealth(); } catch {}
        const healthHistory = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const ds = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
          const e  = allHealth.find(x => x.date === ds);
          healthHistory.push({ date: ds, pain: e?.painLevel ?? null, mood: e?.mood ?? null });
        }
        const pain30 = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const ds = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
          const e  = allHealth.find(x => x.date === ds);
          pain30.push({ date: ds, pain: e?.painLevel ?? null, sleep: e?.sleep ?? null, mood: e?.mood ?? null });
        }
        const sleepVals = pain30.map(x => x.sleep).filter(v => typeof v === 'number');
        const avgSleep  = sleepVals.length ? (sleepVals.reduce((a, b) => a + b, 0) / sleepVals.length) : null;
        const moodVals  = pain30.map(x => x.mood).filter(v => typeof v === 'number');
        const avgMood   = moodVals.length ? (moodVals.reduce((a, b) => a + b, 0) / moodVals.length) : null;

        // Habits — include weekly log so UI can render 7-day dots.
        const habitList = await getHabits();
        const weekDates = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          weekDates.push(d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }));
        }
        const habits = habitList.map(habit => ({
          id:        habit.id,
          name:      habit.name,
          icon:      habit.icon,
          frequency: habit.frequency,
          streak:    habit.streak,
          doneToday: !!(habit.logs || []).find(l => l.date === today && l.done),
          week:      weekDates.map(ds => ({
            date: ds,
            done: !!(habit.logs || []).find(l => l.date === ds && l.done),
          })),
        }));

        // Expenses (current month)
        const exps = await getMonthlyExpenses();
        let total_ils = 0, total_usd = 0;
        const byCat = {};
        for (const e of exps) {
          if (!e.amount || e.amount <= 0) continue;
          const cur = e.currency || 'ILS';
          if (cur === 'USD') total_usd += e.amount;
          else total_ils += e.amount;
          if (cur === 'ILS') {
            const cat = e.category || 'other';
            byCat[cat] = (byCat[cat] || 0) + e.amount;
          }
        }
        const recentExpenses = (await getExpenses()).slice(0, 10).map(e => ({
          id: e.id, vendor: e.vendor, amount: e.amount, currency: e.currency,
          category: e.category, date: e.date,
        }));

        // Tasks — full lists for the Tasks tab
        const allTasks   = await loadTasks();
        const openTasks  = await getOpenTasks();
        const doneToday  = await getCompletedToday();
        const byPriority = {
          high:   openTasks.filter(t => t.priority === 'high').length,
          medium: openTasks.filter(t => t.priority === 'medium').length,
          low:    openTasks.filter(t => t.priority === 'low').length,
        };
        const tasksFull = {
          open: openTasks.map(t => ({ id: t.id, text: t.text, priority: t.priority, createdAt: t.createdAt })),
          done: allTasks.filter(t => t.done).slice(-20).reverse().map(t => ({
            id: t.id, text: t.text, priority: t.priority, doneAt: t.doneAt,
          })),
          openCount:     openTasks.length,
          doneToday:     doneToday.length,
          byPriority,
        };

        // Stocks — live prices from watchlist
        const watchlist = await getWatchlistForChat(chatId);
        const stocks = [];
        for (const w of watchlist) {
          try {
            const s = await fetchStockPrice(w.symbol);
            stocks.push({
              symbol: s.symbol, name: s.name, price: s.price, changePct: s.changePct,
              currency: s.currency, threshold: w.threshold, direction: w.direction,
              triggered: !!w.triggered,
            });
          } catch {
            stocks.push({
              symbol: w.symbol, name: w.symbol, price: null, changePct: 0, currency: 'USD',
              threshold: w.threshold, direction: w.direction, triggered: !!w.triggered,
            });
          }
        }

        // Leads
        const { loadLeads, getLeadsSummary } = require('./leads');
        const allLeads = await loadLeads();
        const leads = allLeads.slice(0, 20);
        const leadsSummary = await getLeadsSummary();

        // 7d+prev7d history for sparklines (safe: fails to { available: false })
        const history = await getMetricsHistory(req.chatId).catch(e => {
          console.warn('[Dashboard] getMetricsHistory failed:', e.message);
          return { available: false };
        });

        const body = JSON.stringify({
          // Legacy shape kept for backwards compatibility with the old HTML
          health,
          healthHistory,
          habits,
          expenses: {
            total_ils: Math.round(total_ils * 100) / 100,
            total_usd: Math.round(total_usd * 100) / 100,
            count: exps.length,
            byCat,
            recent: recentExpenses,
          },
          tasks: {
            open: tasksFull.openCount,
            completed_today: tasksFull.doneToday,
            byPriority: tasksFull.byPriority,
            openList: tasksFull.open,
            doneList: tasksFull.done,
          },
          openTasks: tasksFull.open.slice(0, 8),
          stocks,
          leads: leads.map(l => ({
            id: l.id,
            name: l.data?.['שם'] || l.data?.name || '—',
            email: l.data?.['אימייל'] || l.data?.email || '',
            phone: l.data?.['טלפון'] || l.data?.phone || '',
            title: l.title,
            status: l.status,
            createdAt: l.createdAt,
            notes: l.notes || '',
          })),
          leadsSummary,
          pain30,
          avgSleep: avgSleep != null ? Math.round(avgSleep * 10) / 10 : null,
          avgMood:  avgMood  != null ? Math.round(avgMood  * 10) / 10 : null,
          history,
          supabase: supabaseEnabled(),
          timestamp: new Date().toISOString(),
        });
        res.writeHead(200, {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
          'Content-Length':              Buffer.byteLength(body),
        });
        res.end(body);
      } catch (e) {
        const body = JSON.stringify({ error: e.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(body);
      }
    });
  }

  // ── Dashboard POST API endpoints ──────────────────────────────────────────────

  // CORS preflight for /api/*
  if (req.method === 'OPTIONS' && route.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Helper: read JSON body
  function readJsonBody(r) {
    return new Promise((resolve, reject) => {
      let raw = '';
      r.on('data', c => { raw += c; });
      r.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } });
      r.on('error', reject);
    });
  }

  function apiJson(r, obj, status = 200) {
    const body = JSON.stringify(obj);
    r.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
    r.end(body);
  }

  // POST /api/log-habit — { id, done } (protected)
  if (req.method === 'POST' && route === '/api/log-habit') {
    return requireAuth(req, res, async () => {
      readJsonBody(req).then(async b => {
        const { logHabit } = require('./habits');
        const result = await logHabit(Number(b.id), b.done !== false);
        if (!result) return apiJson(res, { ok: false, e: 'not_found' }, 404);
        apiJson(res, { ok: true, streak: result.streak });
      }).catch(e => apiJson(res, { ok: false, e: e.message }, 400));
    });
  }

  // POST /api/log-health — { pain, mood, sleep } (protected)
  if (req.method === 'POST' && route === '/api/log-health') {
    return requireAuth(req, res, async () => {
      readJsonBody(req).then(async b => {
        const { logDirect } = require('./health');
        await logDirect({ pain: parseFloat(b.pain), mood: parseFloat(b.mood), sleep: parseFloat(b.sleep) });
        apiJson(res, { ok: true });
      }).catch(e => apiJson(res, { ok: false, e: e.message }, 400));
    });
  }

  // POST /api/add-task — { text } (protected)
  if (req.method === 'POST' && route === '/api/add-task') {
    return requireAuth(req, res, async () => {
      readJsonBody(req).then(async b => {
        const { addTask } = require('./tasks');
        const task = await addTask(String(b.text || '').trim());
        if (!task) return apiJson(res, { ok: false, e: 'empty_text' }, 400);
        if (task.isDuplicate) return apiJson(res, { ok: false, e: 'duplicate', id: task.id }, 409);
        apiJson(res, { ok: true, id: task.id });
      }).catch(e => apiJson(res, { ok: false, e: e.message }, 400));
    });
  }

  // POST /api/complete-task — { id } toggles task done by numeric id (protected)
  if (req.method === 'POST' && route === '/api/complete-task') {
    return requireAuth(req, res, async () => {
      readJsonBody(req).then(async b => {
        const { loadTasks, markDone, markUndone, getOpenTasks } = require('./tasks');
        const id = Number(b.id);
        if (!id) return apiJson(res, { ok: false, e: 'missing_id' }, 400);
        const all = await loadTasks();
        const t = all.find(x => x.id === id);
        if (!t) return apiJson(res, { ok: false, e: 'not_found' }, 404);

        if (t.done) {
          const done = all.filter(x => x.done);
          const idx = done.findIndex(x => x.id === id) + 1;
          await markUndone(idx);
        } else {
          const open = (await getOpenTasks());
          const idx = open.findIndex(x => x.id === id) + 1;
          await markDone(idx);
        }
        apiJson(res, { ok: true });
      }).catch(e => apiJson(res, { ok: false, e: e.message }, 400));
    });
  }

  // POST /api/delete-task — { id } (protected)
  if (req.method === 'POST' && route === '/api/delete-task') {
    return requireAuth(req, res, async () => {
      readJsonBody(req).then(async b => {
        const { loadTasks, deleteTask: delTask, getOpenTasks } = require('./tasks');
        const id = Number(b.id);
        if (!id) return apiJson(res, { ok: false, e: 'missing_id' }, 400);
        const all = await loadTasks();
        const t = all.find(x => x.id === id);
        if (!t) return apiJson(res, { ok: false, e: 'not_found' }, 404);
        const open = await getOpenTasks();
        const idx = open.findIndex(x => x.id === id) + 1;
        if (idx === 0) return apiJson(res, { ok: false, e: 'not_open' }, 400);
        await delTask(idx);
        apiJson(res, { ok: true });
      }).catch(e => apiJson(res, { ok: false, e: e.message }, 400));
    });
  }

  // POST /api/add-expense — { vendor, amount, currency, category } (protected)
  if (req.method === 'POST' && route === '/api/add-expense') {
    return requireAuth(req, res, async () => {
      readJsonBody(req).then(async b => {
        const { saveInvoice } = require('./expenses');
        const entry = await saveInvoice({
          vendor:   b.vendor   || 'ידני',
          amount:   parseFloat(b.amount) || 0,
          currency: b.currency || 'ILS',
          category: b.category || 'other',
          source:   'dashboard',
        });
        apiJson(res, { ok: true, id: entry.id });
      }).catch(e => apiJson(res, { ok: false, e: e.message }, 400));
    });
  }

  // POST /api/logout — clears token from DB + cookie (protected)
  if (req.method === 'POST' && route === '/api/logout') {
    (async () => {
      const tok = extractToken(req);
      if (tok) await deleteToken(tok);
      res.setHeader('Set-Cookie',
        'dashboard_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
      apiJson(res, { ok: true });
    })().catch(e => apiJson(res, { ok: false, e: e.message }, 500));
    return;
  }

  // POST /api/form-submit — form submissions forwarded to Telegram + saved as lead
  if (req.method === 'POST' && route === '/api/form-submit') {
    readJsonBody(req).then(async b => {
      const { title, data, chatId: bodyChat } = b;
      const targetChat = bodyChat || process.env.TELEGRAM_CHAT_ID || mainChatId;
      if (!targetChat) return apiJson(res, { ok: false, e: 'no_chat_id' }, 400);

      // Save to leads
      const { saveLead } = require('./leads');
      const lead = await saveLead(title || 'טופס', data || {});

      // Build message
      let msg = `📋 <b>ליד חדש: ${title || 'טופס'}</b>\n\n`;
      for (const [k, v] of Object.entries(data || {})) {
        msg += `<b>${k}:</b> ${v}\n`;
      }
      msg += `\n<i>${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</i>`;

      // Send with inline keyboard
      bot.sendMessage(targetChat, msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ סמן כטופל',     callback_data: `lead_done_${lead.id}`    },
            { text: '⏰ דחה 24 שעות',   callback_data: `lead_snooze_${lead.id}`  },
            { text: '📋 פרטים',          callback_data: `lead_details_${lead.id}` },
          ]],
        },
      });

      apiJson(res, { ok: true, leadId: lead.id });
    }).catch(e => apiJson(res, { ok: false, e: e.message }, 400));
    return;
  }

  // GET /api/backups — list recent backups (protected)
  if (req.method === 'GET' && route === '/api/backups') {
    return requireAuth(req, res, async () => {
      try {
        const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 30, 100);
        const items = await listBackups(limit);
        apiJson(res, { ok: true, backups: items });
      } catch (e) {
        apiJson(res, { ok: false, e: e.message }, 500);
      }
    });
  }

  // POST /api/backup/trigger — manual backup (protected)
  if (req.method === 'POST' && route === '/api/backup/trigger') {
    return requireAuth(req, res, async () => {
      try {
        const result = await performBackup('manual');
        if (!result.success) return apiJson(res, { ok: false, e: result.error || 'failed' }, 500);
        apiJson(res, {
          ok: true,
          id: result.id,
          size: result.size,
          recordCount: result.recordCount,
          durationMs: result.durationMs,
        });
      } catch (e) {
        apiJson(res, { ok: false, e: e.message }, 500);
      }
    });
  }

  // GET /api/backups/:id — download full backup JSON (protected)
  if (req.method === 'GET' && route.startsWith('/api/backups/')) {
    return requireAuth(req, res, async () => {
      try {
        const id = decodeURIComponent(route.slice('/api/backups/'.length));
        if (!id || !/^bkp_(auto|manual)_/.test(id)) {
          return apiJson(res, { ok: false, e: 'invalid_id' }, 400);
        }
        const row = await getBackup(id);
        if (!row) return apiJson(res, { ok: false, e: 'not_found' }, 404);
        const body = JSON.stringify(row.data || {}, null, 2);
        res.writeHead(200, {
          'Content-Type':        'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${id}.json"`,
          'Content-Length':      Buffer.byteLength(body),
        });
        res.end(body);
      } catch (e) {
        apiJson(res, { ok: false, e: e.message }, 500);
      }
    });
  }

  // Default keep-alive / wake-up ping — 2 bytes
  res.sendDate = false;
  res.writeHead(200, { 'Content-Length': '2', 'Connection': 'close' });
  res.end('OK');
});

// Disable automatic Date header — keeps responses tiny for cron-job.org
server.sendDate = false;

// ── One-shot chat_id backfill (idempotent) ──────────────────────────────────
async function backfillChatIds() {
  const chatId = Number(process.env.TELEGRAM_CHAT_ID);
  if (!chatId) {
    console.warn('[Backfill] TELEGRAM_CHAT_ID not set, skipping');
    return;
  }
  if (!supaEnabled()) return;

  const tables = ['tasks', 'habits', 'health_logs', 'expenses', 'leads'];
  for (const t of tables) {
    try {
      const { data, error } = await supaClient
        .from(t).update({ chat_id: chatId })
        .is('chat_id', null)
        .select('id');
      if (error) throw error;
      const count = (data || []).length;
      if (count > 0) console.log(`[Backfill] Set chat_id on ${count} rows in ${t}`);
    } catch (e) {
      console.warn(`[Backfill] ${t} error:`, e.message);
    }
  }
}
backfillChatIds().catch(e => console.warn('[Backfill] Failed:', e.message));

server.listen(PORT, () => {
  console.log(`✅ HTTP server listening on port ${PORT}`);
});
