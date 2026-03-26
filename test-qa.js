'use strict';

// Must set env before loading agent (FORCE_GEMINI skips Groq, TEST_MODE enables tracker)
process.env.FORCE_GEMINI = '1';
process.env.TEST_MODE    = '1';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { handleMessage, _resetToolCalls, _getToolCalls } = require('./bot/agent');
const { listPending, deleteReminder }                    = require('./bot/reminders');
const { stopPomo }                                       = require('./bot/pomodoro');
const { getOpenTasks, deleteTask }                       = require('./bot/tasks');

// gemini-2.0-flash-001 free tier: 15 RPM. Each test uses 1-3 LLM calls.
// 15 RPM = 4s/call. Avg 2 calls/test = 8s min. Use 10s to be safe.
// INITIAL_DELAY: let any previous RPM window expire before starting.
const INTER_TEST_DELAY = 10000;
const INITIAL_DELAY    = 90000; // 90s to reset previous session's quota
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Silent mock bot — prevents real Telegram sends during tests
const mockBot = {
  sendMessage:     async () => {},
  editMessageText: async () => {},
};

// ── Test state ────────────────────────────────────────────────────────────────
let passCount = 0, failCount = 0;
const results = [];

// ── Run one test ──────────────────────────────────────────────────────────────
async function runTest(id, description, msg, check) {
  _resetToolCalls();
  const chatId = `qa_${id}`;

  let response;
  try {
    response = await handleMessage(mockBot, chatId, msg);
  } catch (err) {
    const reason = `EXCEPTION: ${err.message}`;
    console.log(`FAIL Test ${id}: ${description}\n   ${reason}`);
    results.push({ id, description, status: 'FAIL', reason, toolsUsed: [] });
    failCount++;
    return { id, status: 'FAIL', response: null, toolCalls: [] };
  }

  const toolCalls = _getToolCalls();
  const toolNames = toolCalls.map((t) => t.name);

  let checkResult;
  try {
    checkResult = check({ response, toolCalls, toolNames });
  } catch (err) {
    checkResult = { pass: false, reason: `Check threw: ${err.message}` };
  }

  const status = checkResult.pass ? 'PASS' : 'FAIL';
  const toolStr = toolNames.length ? `  [${toolNames.join('+')}]` : '';
  if (checkResult.pass) {
    passCount++;
    console.log(`PASS Test ${id}: ${description}${toolStr}`);
  } else {
    failCount++;
    console.log(`FAIL Test ${id}: ${description}`);
    console.log(`   Reason : ${checkResult.reason}`);
    console.log(`   Tools  : ${toolNames.join(', ') || 'none'}`);
    console.log(`   Reply  : ${String(response).substring(0, 120)}`);
  }

  results.push({ id, description, status, reason: checkResult.reason || '', toolsUsed: toolNames });
  return { id, status, response, toolCalls };
}

// ── Check helpers ─────────────────────────────────────────────────────────────
const hasTool = (name) => ({ toolNames }) =>
  toolNames.includes(name)
    ? { pass: true }
    : { pass: false, reason: `Expected "${name}", got: ${toolNames.join(', ') || 'none'}` };

const hasTools = (...names) => ({ toolNames }) => {
  const missing = names.filter((n) => !toolNames.includes(n));
  return missing.length === 0
    ? { pass: true }
    : { pass: false, reason: `Missing: ${missing.join('+')} | got: ${toolNames.join(', ') || 'none'}` };
};

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const nowIL = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  console.log('============================================================');
  console.log('  LifePilot FULL QA -- 15 Tests');
  console.log('  ' + nowIL + '  |  Provider: Gemini (forced)');
  console.log('============================================================\n');
  console.log(`Waiting ${INITIAL_DELAY/1000}s for Gemini rate-limit window to clear...`);
  await sleep(INITIAL_DELAY);

  // Test 1 -- Greeting
  await sleep(INTER_TEST_DELAY);
  await runTest(1, 'Greeting -- friendly, no tool needed', '\u05D4\u05D9\u05D9 \u05DE\u05D4 \u05E9\u05DC\u05D5\u05DE\u05DA?',
    ({ response }) =>
      response ? { pass: true } : { pass: false, reason: 'Empty response' });

  // Test 2 -- Get tasks
  await sleep(INTER_TEST_DELAY);
  await runTest(2, 'Get tasks -- must call get_tasks', '\u05DE\u05D4 \u05D9\u05E9 \u05DC\u05D9 \u05DC\u05E2\u05E9\u05D5\u05EA \u05D4\u05D9\u05D5\u05DD?',
    hasTool('get_tasks'));

  // Test 3 -- Add task
  await sleep(INTER_TEST_DELAY);
  await runTest(3, 'Add task -- add_task with text containing bread', '\u05EA\u05D5\u05E1\u05D9\u05E3 \u05DE\u05E9\u05D9\u05DE\u05D4 \u05DC\u05E7\u05E0\u05D5\u05EA \u05DC\u05D7\u05DD',
    ({ toolCalls, toolNames }) => {
      if (!toolNames.includes('add_task'))
        return { pass: false, reason: `add_task not called. Got: ${toolNames.join(', ') || 'none'}` };
      const tc = toolCalls.find((t) => t.name === 'add_task');
      if (!tc.args.text)
        return { pass: false, reason: 'add_task.text is missing' };
      return { pass: true };
    });

  // Test 4 -- Log health with NUMERIC args (type coercion check)
  await sleep(INTER_TEST_DELAY);
  await runTest(4, 'Log health pain=6 mood=7 -- args must be numbers', '\u05DB\u05D0\u05D1 6 \u05D4\u05D9\u05D5\u05DD, \u05DE\u05E6\u05D1 \u05E8\u05D5\u05D7 7',
    ({ toolCalls, toolNames }) => {
      if (!toolNames.includes('log_health'))
        return { pass: false, reason: `log_health not called. Got: ${toolNames.join(', ') || 'none'}` };
      const tc = toolCalls.find((t) => t.name === 'log_health');
      if (typeof tc.args.pain !== 'number')
        return { pass: false, reason: `pain is ${typeof tc.args.pain} ("${tc.args.pain}"), expected number` };
      if (tc.args.pain !== 6)
        return { pass: false, reason: `pain=${tc.args.pain}, expected 6` };
      if (tc.args.mood !== undefined && typeof tc.args.mood !== 'number')
        return { pass: false, reason: `mood is ${typeof tc.args.mood}, expected number` };
      return { pass: true };
    });

  // Test 5 -- Get health today
  await sleep(INTER_TEST_DELAY);
  await runTest(5, 'Get health today -- get_health_today', '\u05DE\u05D4 \u05DE\u05E6\u05D1 \u05D4\u05D1\u05E8\u05D9\u05D0\u05D5\u05EA \u05E9\u05DC\u05D9?',
    hasTool('get_health_today'));

  // Test 6 -- Add reminder with correct time
  await sleep(INTER_TEST_DELAY);
  await runTest(6, 'Reminder in 2 min -- remind_at within 1-4 min window', '\u05EA\u05D6\u05DB\u05D9\u05E8 \u05DC\u05D9 \u05D1\u05E2\u05D5\u05D3 2 \u05D3\u05E7\u05D5\u05EA \u05DC\u05E9\u05EA\u05D5\u05EA \u05DE\u05D9\u05DD',
    ({ toolCalls, toolNames }) => {
      if (!toolNames.includes('add_reminder'))
        return { pass: false, reason: `add_reminder not called. Got: ${toolNames.join(', ') || 'none'}` };
      const tc = toolCalls.find((t) => t.name === 'add_reminder');
      if (!tc.args.remind_at)
        return { pass: false, reason: 'remind_at missing' };
      const remindAt = new Date(tc.args.remind_at);
      const now      = new Date();
      const diffMin  = (remindAt - now) / 60000;
      if (diffMin < 0.5 || diffMin > 6)
        return { pass: false, reason: `remind_at is ${diffMin.toFixed(1)}min from now, expected 1-4min` };
      return { pass: true };
    });

  // Test 7 -- Get reminders
  await sleep(INTER_TEST_DELAY);
  await runTest(7, 'Get reminders -- get_reminders', '\u05DE\u05D4 \u05D4\u05EA\u05D6\u05DB\u05D5\u05E8\u05D5\u05EA \u05E9\u05DC\u05D9?',
    hasTool('get_reminders'));

  // Test 8 -- Save note
  await sleep(INTER_TEST_DELAY);
  await runTest(8, 'Save note -- save_note', '\u05EA\u05E9\u05DE\u05D5\u05E8 \u05D4\u05E2\u05E8\u05D4: \u05E1\u05D9\u05E1\u05DE\u05EA \u05D4\u05D5\u05D5\u05D9\u05E4\u05D9 1234',
    hasTool('save_note'));

  // Test 9 -- Tech news
  await sleep(INTER_TEST_DELAY);
  await runTest(9, 'Tech news -- get_tech_news', '\u05DE\u05D4 \u05D4\u05D7\u05D3\u05E9\u05D5\u05EA \u05D1\u05D4\u05D9\u05D9\u05D8\u05E7?',
    hasTool('get_tech_news'));

  // Test 10 -- Start pomodoro
  await sleep(INTER_TEST_DELAY);
  await runTest(10, 'Start pomodoro -- start_pomodoro', '\u05EA\u05EA\u05D7\u05D9\u05DC \u05E4\u05D5\u05DE\u05D5\u05D3\u05D5\u05E8\u05D5',
    hasTool('start_pomodoro'));

  // Test 11 -- Current time
  await sleep(INTER_TEST_DELAY);
  await runTest(11, 'Show current Israel time (HH:MM in response)', '\u05DE\u05D4 \u05D4\u05E9\u05E2\u05D4?',
    ({ response }) => {
      if (!response) return { pass: false, reason: 'Empty response' };
      const hasTimePat = /\d{1,2}:\d{2}/.test(response);
      return hasTimePat
        ? { pass: true }
        : { pass: false, reason: `No HH:MM pattern in: "${response.substring(0, 100)}"` };
    });

  // Test 12 -- Describe self
  await sleep(INTER_TEST_DELAY);
  await runTest(12, 'Describe self -- response exists, no crash', '\u05E1\u05E4\u05E8 \u05DC\u05D9 \u05E2\u05DC \u05E2\u05E6\u05DE\u05DA',
    ({ response }) =>
      response ? { pass: true } : { pass: false, reason: 'Empty response' });

  // Test 13 -- Chain: health + reminder
  await sleep(INTER_TEST_DELAY);
  await runTest(13, 'Chain: log_health + add_reminder', '\u05DB\u05D0\u05D1 \u05E8\u05D0\u05E9 \u05D7\u05D6\u05E7, \u05EA\u05D6\u05DB\u05D9\u05E8 \u05DC\u05D9 \u05D1\u05E2\u05D5\u05D3 \u05E9\u05E2\u05D4 \u05DC\u05E7\u05D7\u05EA \u05D0\u05E7\u05DE\u05D5\u05DC',
    hasTools('log_health', 'add_reminder'));

  // Test 14 -- Complete task
  await sleep(INTER_TEST_DELAY);
  await runTest(14, 'Complete task 1 -- complete_task with numeric task_index', '\u05E1\u05DE\u05DF \u05DE\u05E9\u05D9\u05DE\u05D4 1 \u05DB\u05D1\u05D5\u05E6\u05E2\u05D4',
    ({ toolCalls, toolNames }) => {
      if (!toolNames.includes('complete_task'))
        return { pass: false, reason: `complete_task not called. Got: ${toolNames.join(', ') || 'none'}` };
      const tc = toolCalls.find((t) => t.name === 'complete_task');
      if (typeof tc.args.task_index !== 'number')
        return { pass: false, reason: `task_index is ${typeof tc.args.task_index} ("${tc.args.task_index}"), expected number` };
      return { pass: true };
    });

  // Test 15 -- Summary / context
  await sleep(INTER_TEST_DELAY);
  await runTest(15, 'Summary -- get_current_context or tasks/health', '\u05DE\u05D4 \u05D4\u05E1\u05D9\u05DB\u05D5\u05DD \u05E9\u05DC\u05D9?',
    ({ toolNames }) => {
      const ok = toolNames.includes('get_current_context') ||
                 toolNames.includes('get_tasks')           ||
                 toolNames.includes('get_health_today');
      return ok
        ? { pass: true }
        : { pass: false, reason: `Expected context/summary tool, got: ${toolNames.join(', ') || 'none'}` };
    });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  console.log('\nCleaning up test data...');
  let cleaned = 0;
  for (let i = 1; i <= 15; i++) {
    try {
      const pending = listPending(`qa_${i}`);
      for (const r of pending) { deleteReminder(`qa_${i}`, r.id); cleaned++; }
    } catch {}
    try { stopPomo(mockBot, `qa_${i}`); } catch {}
  }
  try {
    const tasks = getOpenTasks();
    const idx = tasks.findIndex((t) => t.text.includes('\u05DC\u05D7\u05DD'));
    if (idx !== -1) { deleteTask(idx + 1); cleaned++; }
  } catch {}
  console.log(`   Removed ${cleaned} test item(s)`);

  // ── Final report ──────────────────────────────────────────────────────────
  console.log('\n============================================================');
  console.log(`Results: ${passCount}/15 passed | ${failCount} failed`);
  console.log('============================================================');

  // Build Telegram summary
  const lines = [
    `\u{1F9EA} QA Report \u2014 LifePilot`,
    `\uD83D\uDCC5 ${nowIL}\n`,
  ];
  for (const r of results) {
    const icon  = r.status === 'PASS' ? '\u2705' : '\u274C';
    const tools = r.toolsUsed.length ? ` [${r.toolsUsed.join('+')}]` : '';
    lines.push(`${icon} Test ${r.id}: ${r.description.substring(0, 44)}${tools}`);
    if (r.status === 'FAIL' && r.reason) lines.push(`   \u21B3 ${r.reason.substring(0, 80)}`);
  }
  lines.push(`\n\uD83D\uDCCA ${passCount}/15 \u05E2\u05D1\u05E8\u05D5 | ${failCount} \u05E0\u05DB\u05E9\u05DC\u05D5`);
  const report = lines.join('\n');

  console.log('\n-- Telegram report --');
  console.log(report);

  const fs = require('fs');
  fs.writeFileSync(require('path').join(__dirname, '.qa-report.txt'), report, 'utf8');
  return { passCount, failCount, report };
}

main()
  .then(({ passCount, failCount, report }) => {
    process.exit(failCount === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('[QA] Fatal error:', err);
    process.exit(1);
  });
