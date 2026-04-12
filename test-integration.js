#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const results = [];

function pass(name) {
  console.log(`✅ PASS — ${name}`);
  results.push({ name, status: 'PASS' });
  passed++;
}

function fail(name, err) {
  console.log(`❌ FAIL — ${name}: ${err}`);
  results.push({ name, status: 'FAIL', err: String(err) });
  failed++;
}

// ── Mock bot (for modules that need it) ────────────────────────────────────────
const mockBot = {
  _msgs: [],
  sendMessage(chatId, text) {
    this._msgs.push({ chatId, text });
    return Promise.resolve({ message_id: 99 });
  },
};

// ── Cleanup helpers ────────────────────────────────────────────────────────────
const cleanups = [];
function onCleanup(fn) { cleanups.push(fn); }
async function runCleanups() {
  for (const fn of cleanups) { try { await fn(); } catch {} }
}

// ══════════════════════════════════════════════════════════════════════════════
async function runTests() {

  // ── F-01: Morning Message ──────────────────────────────────────────────────
  try {
    const { buildMorningMessage } = require('./bot/scheduler');
    const msg = await buildMorningMessage();
    if (!msg.includes('בוקר טוב') && !msg.includes('שילה')) throw new Error('missing greeting');
    if (!msg.includes('📅')) throw new Error('missing date line');
    pass('F-01 Morning Message');
    console.log('   Preview:', msg.replace(/<[^>]+>/g, '').split('\n').slice(0, 3).join(' | '));
  } catch (e) { fail('F-01 Morning Message', e.message); }

  // ── F-02: Task Management ──────────────────────────────────────────────────
  let testTaskId;
  try {
    const { addTask, formatOpenTasks, markDone, deleteTask, loadTasks } = require('./bot/tasks');
    const task = addTask('integration test task');
    testTaskId = task.id;
    onCleanup(() => { try { deleteTask(task.index ?? 1); } catch {} });

    if (!task.id || !task.text) throw new Error('task missing id/text');
    const fmt = formatOpenTasks();
    if (!fmt.includes('integration test task')) throw new Error('task not in list');
    const done = markDone(task.id);
    if (!done) throw new Error('markDone returned false');
    pass('F-02 Task Management');
  } catch (e) { fail('F-02 Task Management', e.message); }

  // ── F-03: Health Check-in ─────────────────────────────────────────────────
  try {
    const DATA = path.join(__dirname, 'data', 'health.json');
    const entries = (() => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return []; } })();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

    // Directly write a test health entry
    const testEntry = { date: today + '-TEST', painLevel: 5, mood: 7, sleep: 7, symptoms: '', notes: 'integration test', ts: new Date().toISOString() };
    entries.push(testEntry);
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    fs.writeFileSync(DATA, JSON.stringify(entries, null, 2));
    onCleanup(() => {
      const e2 = JSON.parse(fs.readFileSync(DATA, 'utf8')).filter(e => e.date !== today + '-TEST');
      fs.writeFileSync(DATA, JSON.stringify(e2, null, 2));
    });

    // Verify it reads back
    const { getWeekSummary } = require('./bot/health');
    const summary = getWeekSummary(7);
    if (typeof summary !== 'string') throw new Error('getWeekSummary returned non-string');
    pass('F-03 Health Tracking');
  } catch (e) { fail('F-03 Health Tracking', e.message); }

  // ── F-04: English Daily Word ───────────────────────────────────────────────
  try {
    const { getDailyWord, formatWord } = require('./bot/english');
    const word = await getDailyWord();
    if (!word.word || !word.translation) throw new Error('missing word/translation');
    const fmt = formatWord(word);
    if (!fmt.includes(word.word)) throw new Error('formatWord missing word');
    pass('F-04 English Daily Word');
    console.log(`   Word: ${word.word} = ${word.translation} (${word.difficulty})`);
  } catch (e) { fail('F-04 English Daily Word', e.message); }

  // ── F-05: Pomodoro Timer ───────────────────────────────────────────────────
  try {
    const { startPomo, stopPomo, statsPomo } = require('./bot/pomodoro');

    // startPomo sends a message via bot — use mockBot
    await startPomo(mockBot, 'test-chat', 1); // 1 min for test
    const startMsg = mockBot._msgs.find(m => m.text?.includes('סשן'));
    if (!startMsg) throw new Error('no start message sent');

    // Stop it
    await stopPomo(mockBot, 'test-chat');
    const stopMsg = mockBot._msgs.find(m => m.text?.includes('הופסק') || m.text?.includes('פעיל'));
    if (!stopMsg) throw new Error('no stop/status message');

    pass('F-05 Pomodoro Timer');
  } catch (e) { fail('F-05 Pomodoro Timer', e.message); }

  // ── F-06: Tech News ────────────────────────────────────────────────────────
  try {
    // Test HN API directly
    const https = require('https');
    const idsJson = await new Promise((res, rej) => {
      const req = https.get('https://hacker-news.firebaseio.com/v0/topstories.json', r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
      });
      req.on('error', rej);
      req.setTimeout(8000, () => { req.destroy(); rej(new Error('timeout')); });
    });
    const ids = JSON.parse(idsJson);
    if (!Array.isArray(ids) || ids.length < 5) throw new Error('HN API returned < 5 stories');

    // Test the sendNews function (mock bot)
    const newsMockBot = { sendMessage: (id, text) => Promise.resolve({ message_id: 1 }) };
    const { sendNews } = require('./bot/news');
    await sendNews(newsMockBot, 'test-chat', false);
    pass('F-06 Tech News');
    console.log(`   HN API: ${ids.length} stories available`);
  } catch (e) { fail('F-06 Tech News', e.message); }

  // ── F-07: Natural Language Reminders ──────────────────────────────────────
  let testReminderId;
  try {
    const { addReminder, listPending, deleteReminder } = require('./bot/reminders');
    const reminder = await addReminder('test-chat-99', 'remind me in 2 hours to test');
    if (!reminder) throw new Error('parseReminder returned null (Gemini parse failed)');
    testReminderId = reminder.id;
    onCleanup(() => deleteReminder('test-chat-99', testReminderId));

    if (!reminder.task || !reminder.remindAt) throw new Error('missing task/remindAt');
    const pending = listPending('test-chat-99');
    if (!pending.find(r => r.id === testReminderId)) throw new Error('reminder not found in pending');
    pass('F-07 Reminders');
    console.log(`   Parsed: "${reminder.task}" @ ${reminder.remindAt}`);
  } catch (e) { fail('F-07 Reminders', e.message); }

  // ── F-08: Medications ─────────────────────────────────────────────────────
  try {
    const { addMedication, removeMedication, markTaken, formatTodayStatus } = require('./bot/medications');
    const added = addMedication('TestMed', '08:00', '10mg');
    if (!added) throw new Error('addMedication returned false');
    onCleanup(() => removeMedication('TestMed'));

    const taken = markTaken('TestMed');
    if (!taken) throw new Error('markTaken returned false');
    const status = formatTodayStatus();
    if (!status.includes('TestMed')) throw new Error('TestMed not in status');
    pass('F-08 Medications');
  } catch (e) { fail('F-08 Medications', e.message); }

  // ── F-09: WordPress Site Monitor ──────────────────────────────────────────
  try {
    const { addSite, removeSite, load: loadSites } = require('./bot/sites');
    onCleanup(() => removeSite('Google-Test'));

    const res = addSite('https://www.google.com', 'Google-Test');
    if (!res.ok) throw new Error('addSite failed: ' + (res.reason || ''));

    // Check it
    const { checkSite } = (() => {
      // re-require with checkSite exposed via a quick patch
      const m = require('./bot/sites');
      return m;
    })();

    // Verify it was saved
    const sites = loadSites();
    const site = sites.find(s => s.name === 'Google-Test');
    if (!site) throw new Error('site not saved');

    // Actual HTTP check
    const https = require('https');
    const { status } = await new Promise((resolve) => {
      const req = https.get('https://www.google.com', { timeout: 8000, headers: { 'User-Agent': 'LifePilot/1.0' } }, (r) => {
        r.resume(); resolve({ status: r.statusCode });
      });
      req.on('error', () => resolve({ status: 0 }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    });
    if (status !== 200) throw new Error(`google.com returned ${status}`);
    pass('F-09 WordPress Monitor');
    console.log(`   google.com: HTTP ${status}`);
  } catch (e) { fail('F-09 WordPress Monitor', e.message); }

  // ── F-10: Weekly Summary ───────────────────────────────────────────────────
  try {
    const { buildWeeklySummaryMessage } = require('./bot/weekly-summary');
    const msg = await buildWeeklySummaryMessage();
    if (!msg.includes('סיכום שבועי')) throw new Error('missing header');
    if (!msg.includes('משימות')) throw new Error('missing tasks section');
    pass('F-10 Weekly Summary');
    console.log('   Preview:', msg.replace(/<[^>]+>/g, '').split('\n').slice(0, 4).join(' | '));
  } catch (e) { fail('F-10 Weekly Summary', e.message); }

  // ── F-11: Notes & Snippets ─────────────────────────────────────────────────
  let testNoteId;
  try {
    const { addNote, searchNotes, deleteNote } = require('./bot/notes');
    const note = await addNote('integration test note — Render PORT env var trick');
    testNoteId = note.id;
    onCleanup(() => deleteNote(testNoteId));

    if (!note.id || !note.title) throw new Error('note missing id/title');
    const results = searchNotes('integration test');
    if (!results.find(n => n.id === testNoteId)) throw new Error('note not found in search');
    pass('F-11 Notes & Snippets');
    console.log(`   Note #${note.id}: "${note.title}" tags: [${note.tags.join(', ')}]`);
  } catch (e) { fail('F-11 Notes & Snippets', e.message); }

  // ── F-12: Daily Summary ────────────────────────────────────────────────────
  try {
    const { buildSummaryMessage } = require('./bot/daily-summary');
    const msg = await buildSummaryMessage(0);
    if (!msg.includes('סיכום יומי')) throw new Error('missing header');
    if (!msg.includes('משימות') || !msg.includes('בריאות')) throw new Error('missing sections');
    pass('F-12 Daily Summary');
    console.log('   Preview:', msg.replace(/<[^>]+>/g, '').split('\n').slice(0, 5).join(' | '));
  } catch (e) { fail('F-12 Daily Summary', e.message); }

}

// ── Run ────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🧪 LifePilot Integration Tests\n' + '─'.repeat(50));
  await runTests();
  console.log('\n' + '─'.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  await runCleanups();
  console.log('🧹 Test data cleaned up');

  // Write result summary for Telegram
  const summary = results.map(r => `${r.status === 'PASS' ? '✅' : '❌'} ${r.name}${r.err ? ': ' + r.err.slice(0, 60) : ''}`).join('\n');
  fs.writeFileSync('/tmp/test-results.txt', summary);

  process.exit(failed > 0 ? 1 : 0);
})();
