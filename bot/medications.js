'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const MEDS_FILE = path.join(__dirname, '..', 'data', 'medications.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(MEDS_FILE, 'utf8')); } catch { return []; }
}

function save(meds) {
  fs.mkdirSync(path.dirname(MEDS_FILE), { recursive: true });
  fs.writeFileSync(MEDS_FILE, JSON.stringify(meds, null, 2), 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
}

function nowTimeIL() {
  return new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
}

function nextId(meds) {
  return meds.length === 0 ? 1 : Math.max(...meds.map((m) => m.id)) + 1;
}

// Return today's log entry for a med + time slot (or create one)
function getTodayEntry(med, time) {
  const today = todayIL();
  if (!med.log) med.log = [];
  let entry = med.log.find((e) => e.date === today && e.time === time);
  if (!entry) {
    entry = { date: today, time, status: 'pending', takenAt: null };
    med.log.push(entry);
  }
  return entry;
}

// Keep log lean — keep only last 30 days
function trimLog(med) {
  if (!med.log || med.log.length <= 200) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutStr = cutoff.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  med.log = med.log.filter((e) => e.date >= cutStr);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
function addMedication(name, timesStr, dosage = '') {
  const times = timesStr.split(',').map((t) => t.trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t));
  if (times.length === 0) return { error: 'פורמט שעות לא תקין. דוגמה: 08:00,20:00' };

  const meds = load();
  if (meds.find((m) => m.name.toLowerCase() === name.toLowerCase())) {
    return { error: `התרופה "${name}" כבר קיימת.` };
  }

  const med = { id: nextId(meds), name, dosage, times, days: 'daily', log: [], enabled: true };
  meds.push(med);
  save(meds);
  return { med };
}

function removeMedication(name) {
  const meds = load();
  const idx  = meds.findIndex((m) => m.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return null;
  const [removed] = meds.splice(idx, 1);
  save(meds);
  return removed;
}

function markTaken(name) {
  const meds = load();
  const med  = meds.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (!med) return null;

  // Mark the closest upcoming or current time slot as taken
  const now   = nowTimeIL();
  const today = todayIL();
  if (!med.log) med.log = [];

  // Find nearest time slot (within ±2h of now)
  const [nowH, nowM] = now.split(':').map(Number);
  const nowMin = nowH * 60 + nowM;

  let bestTime = med.times[0];
  let bestDiff = Infinity;
  for (const t of med.times) {
    const [h, m] = t.split(':').map(Number);
    const diff = Math.abs(h * 60 + m - nowMin);
    if (diff < bestDiff) { bestDiff = diff; bestTime = t; }
  }

  let entry = med.log.find((e) => e.date === today && e.time === bestTime);
  if (!entry) {
    entry = { date: today, time: bestTime, status: 'taken', takenAt: new Date().toISOString() };
    med.log.push(entry);
  } else {
    entry.status  = 'taken';
    entry.takenAt = new Date().toISOString();
  }

  trimLog(med);
  save(meds);
  return { med, time: bestTime };
}

function markSkipped(name) {
  const meds = load();
  const med  = meds.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (!med) return null;

  const now   = nowTimeIL();
  const today = todayIL();
  const [nowH, nowM] = now.split(':').map(Number);
  const nowMin = nowH * 60 + nowM;

  let bestTime = med.times[0];
  let bestDiff = Infinity;
  for (const t of med.times) {
    const [h, m] = t.split(':').map(Number);
    const diff = Math.abs(h * 60 + m - nowMin);
    if (diff < bestDiff) { bestDiff = diff; bestTime = t; }
  }

  let entry = med.log.find((e) => e.date === today && e.time === bestTime);
  if (!entry) {
    entry = { date: today, time: bestTime, status: 'skipped', takenAt: null };
    med.log.push(entry);
  } else {
    entry.status = 'skipped';
  }

  trimLog(med);
  save(meds);
  return { med, time: bestTime };
}

// ── Status formatting ─────────────────────────────────────────────────────────
function formatList() {
  const meds = load();
  if (meds.length === 0) return '💊 אין תרופות מוגדרות.\n\n/med add שם 08:00,20:00';

  const lines = meds.map((m) => {
    const status = m.enabled ? '✅' : '⏸️';
    const dosage = m.dosage ? ` — ${m.dosage}` : '';
    return `${status} <b>${m.name}</b>${dosage}\n   🕐 ${m.times.join(' | ')}`;
  });

  return `💊 <b>התרופות שלך (${meds.length})</b>\n\n${lines.join('\n\n')}`;
}

function formatTodayStatus() {
  const meds  = load();
  if (meds.length === 0) return '💊 אין תרופות מוגדרות.';

  const today  = todayIL();
  const nowStr = nowTimeIL();
  const [nowH, nowM] = nowStr.split(':').map(Number);
  const nowMin = nowH * 60 + nowM;

  const lines = [];

  for (const med of meds.filter((m) => m.enabled)) {
    lines.push(`\n💊 <b>${med.name}</b>${med.dosage ? ` (${med.dosage})` : ''}:`);

    for (const t of med.times) {
      const [h, m] = t.split(':').map(Number);
      const slotMin = h * 60 + m;
      const entry   = med.log?.find((e) => e.date === today && e.time === t);
      const status  = entry?.status || 'pending';

      let icon, label;
      if (status === 'taken')   { icon = '✅'; label = `נלקח ב-${entry.takenAt ? new Date(entry.takenAt).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }) : t}`; }
      else if (status === 'skipped') { icon = '⏭️'; label = 'דולג'; }
      else if (slotMin < nowMin - 30) { icon = '❌'; label = `לא נלקח (${t})`; }
      else { icon = '⏳'; label = `מתוכנן ל-${t}`; }

      lines.push(`   ${icon} ${label}`);
    }
  }

  return `📋 <b>סטטוס תרופות היום</b>${lines.join('\n')}`;
}

// ── Export for F-12 daily summary ─────────────────────────────────────────────
function getTodayMedStatus() {
  const meds  = load();
  const today = todayIL();
  const nowStr = nowTimeIL();
  const [nowH, nowM] = nowStr.split(':').map(Number);
  const nowMin = nowH * 60 + nowM;

  const result = { total: 0, taken: 0, missed: 0, skipped: 0, pending: 0 };

  for (const med of meds.filter((m) => m.enabled)) {
    for (const t of med.times) {
      result.total++;
      const [h, m] = t.split(':').map(Number);
      const entry  = med.log?.find((e) => e.date === today && e.time === t);
      const status = entry?.status || (h * 60 + m < nowMin - 30 ? 'missed' : 'pending');
      result[status] = (result[status] || 0) + 1;
    }
  }

  return result;
}

// ── Morning med summary (for /boker) ─────────────────────────────────────────
function getMorningMedSummary() {
  const meds = load().filter((m) => m.enabled);
  if (meds.length === 0) return null;
  const lines = meds.map((m) => `${m.name}: ${m.times.join(', ')}`);
  return `💊 <b>תרופות להיום:</b>\n${lines.join('\n')}`;
}

// ── Reminder scheduler ────────────────────────────────────────────────────────
let activeCronJobs = [];
let followupTimers = [];

function stopMedCrons() {
  activeCronJobs.forEach((j) => j.stop());
  followupTimers.forEach((t) => clearTimeout(t));
  activeCronJobs = [];
  followupTimers = [];
}

function scheduleMedications(bot, chatId) {
  stopMedCrons();

  const meds = load().filter((m) => m.enabled);

  for (const med of meds) {
    for (const time of med.times) {
      const [h, m] = time.split(':').map(Number);

      // Cron: fire at HH:MM UTC+3 = HH-3:MM UTC (handle hour wrap)
      const utcH = ((h - 3) + 24) % 24;
      const cronExpr = `${m} ${utcH} * * *`;

      const job = cron.schedule(cronExpr, async () => {
        const meds2 = load();
        const med2  = meds2.find((x) => x.id === med.id);
        if (!med2 || !med2.enabled) return;

        const today  = todayIL();
        const entry  = med2.log?.find((e) => e.date === today && e.time === time);
        if (entry?.status === 'taken' || entry?.status === 'skipped') return;

        const dosage = med2.dosage ? ` — ${med2.dosage}` : '';
        await bot.sendMessage(chatId,
          `💊 <b>הגיע הזמן לקחת ${med2.name}</b>${dosage}\n` +
          `🕐 מינון מתוכנן: ${time}\n\n` +
          `השב /med taken ${med2.name} כדי לסמן.`,
          { parse_mode: 'HTML' }
        ).catch((e) => console.error('[Med] reminder send error:', e.message));

        // Follow-up after 30 minutes if still not taken
        const timer = setTimeout(async () => {
          const meds3 = load();
          const med3  = meds3.find((x) => x.id === med.id);
          const entry2 = med3?.log?.find((e) => e.date === today && e.time === time);
          if (entry2?.status === 'taken' || entry2?.status === 'skipped') return;

          await bot.sendMessage(chatId,
            `⏰ <b>תזכורת:</b> עדיין לא לקחת <b>${med3.name}</b>\n` +
            `/med taken ${med3.name} — לסימון\n` +
            `/med skip ${med3.name} — לדילוג`,
            { parse_mode: 'HTML' }
          ).catch((e) => console.error('[Med] followup send error:', e.message));
        }, 30 * 60 * 1000);

        followupTimers.push(timer);
      }, { timezone: 'UTC' });

      activeCronJobs.push(job);
    }
  }

  if (meds.length > 0) {
    console.log(`[Medications] Scheduled reminders for ${meds.length} medications`);
  }
}

module.exports = {
  addMedication,
  removeMedication,
  markTaken,
  markSkipped,
  formatList,
  formatTodayStatus,
  getTodayMedStatus,
  getMorningMedSummary,
  scheduleMedications,
};
