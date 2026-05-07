'use strict';

/**
 * Phase 4f.3 Bugs 2+4 regression suite.
 *
 * Bug 2: chat_id naming mismatch — bot/agent.js passes ctx.chatId
 *        (camelCase); the skill previously read ctx.chat_id only.
 *        Fix: resolveChatId widened to accept both forms.
 *
 * Bug 4: hallucination via "[object Object]" coercion — execute()
 *        previously returned objects; bot/skills-registry.js:114 does
 *        String(result), so the agent received "[object Object]" and
 *        Gemini fabricated plausible content. Fix: execute() now returns
 *        JSON-stringified results + structured error envelope with
 *        _do_not_fabricate + _instruction_to_assistant fields.
 *
 * The 3 success-path tests stub the storage layer via Node's module-cache
 * sharing: skills/research/index.js imports the same `articlesStore` /
 * `profileStore` exports objects that this test file requires, so mutating
 * those exports here propagates into the skill. Originals are restored in
 * each test's finally block.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const skill         = require('../skills/research');
const articlesStore = require('../skills/research/storage/articles');
const profileStore  = require('../skills/research/storage/profile');

const _orig = {
  getHistory:          articlesStore.getHistory,
  ensureProfile:       profileStore.ensureProfile,
  getProfile:          profileStore.getProfile,
  needsDisclaimer:     profileStore.needsDisclaimer,
  markDisclaimerShown: profileStore.markDisclaimerShown,
};

function installStubs() {
  articlesStore.getHistory          = async () => [];
  profileStore.ensureProfile        = async () => ({ chat_id: 'stub', treatments: [] });
  profileStore.getProfile           = async () => ({ chat_id: 'stub', treatments: [] });
  profileStore.needsDisclaimer      = async () => false;
  profileStore.markDisclaimerShown  = async () => undefined;
}

function restoreStubs() {
  articlesStore.getHistory          = _orig.getHistory;
  profileStore.ensureProfile        = _orig.ensureProfile;
  profileStore.getProfile           = _orig.getProfile;
  profileStore.needsDisclaimer      = _orig.needsDisclaimer;
  profileStore.markDisclaimerShown  = _orig.markDisclaimerShown;
}

test('execute() accepts camelCase ctx.chatId (bot/agent.js contract)', async () => {
  installStubs();
  try {
    const result = await skill.execute('get_research_history', {}, { chatId: 'test-chat-123' });
    assert.equal(typeof result, 'string', 'execute() must return a JSON string, not an object');
    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, true, `expected ok:true; got: ${result}`);
    assert.ok(!String(parsed.error || '').includes('chat_id missing'),
      'must NOT throw chat_id-missing when ctx.chatId is present');
  } finally { restoreStubs(); }
});

test('execute() accepts snake_case ctx.chat_id (bot/telegram.js /research slash contract)', async () => {
  installStubs();
  try {
    const result = await skill.execute('get_research_history', {}, { chat_id: 'test-chat-456' });
    assert.equal(typeof result, 'string');
    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, true, `expected ok:true; got: ${result}`);
  } finally { restoreStubs(); }
});

test('execute() returns a JSON string on success (Bug 4 anti-hallucination contract)', async () => {
  installStubs();
  try {
    const result = await skill.execute('get_research_history', {}, { chatId: 'test-chat-789' });
    assert.equal(typeof result, 'string',
      'must be a string — bot/skills-registry.js coerces via String(), so an object becomes "[object Object]"');
    assert.doesNotThrow(() => JSON.parse(result), 'must be valid JSON');
  } finally { restoreStubs(); }
});

test('execute() returns structured anti-fabrication error envelope when chat_id missing', async () => {
  // No stubs: the chat_id-missing throw happens before any storage call.
  const result = await skill.execute('search_research', {}, {});
  assert.equal(typeof result, 'string');
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, false);
  assert.ok(String(parsed.error).includes('chat_id missing'),
    `expected "chat_id missing" in error; got: ${parsed.error}`);
  assert.deepEqual(parsed.articles, [], 'articles MUST be [] so a confused model cannot invent entries');
  assert.equal(parsed._do_not_fabricate, true, '_do_not_fabricate flag is the explicit anti-hallucination signal');
  assert.equal(typeof parsed._instruction_to_assistant, 'string');
  assert.ok(parsed._instruction_to_assistant.length > 0, '_instruction_to_assistant must be non-empty');
});

test('execute() returns JSON error envelope on unknown tool name', async () => {
  const result = await skill.execute('nonexistent_tool', {}, { chatId: 'x' });
  assert.equal(typeof result, 'string');
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, false);
  assert.ok(String(parsed.error).includes('Unknown tool'),
    `expected "Unknown tool" in error; got: ${parsed.error}`);
});
