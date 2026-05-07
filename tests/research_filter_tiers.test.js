'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyArticle } = require('../skills/research/filter/tiers');

function makeMockModel(jsonResponse) {
  return {
    async generateContent() {
      return {
        response: {
          text: () => typeof jsonResponse === 'string' ? jsonResponse : JSON.stringify(jsonResponse),
          usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 80, totalTokenCount: 680 },
        },
      };
    },
  };
}

test('pre-filter short-circuits — LLM not called when keyword matches', async () => {
  let llmCalled = false;
  const mockModel = {
    async generateContent() { llmCalled = true; return { response: { text: () => '{}' } }; },
  };
  const r = await classifyArticle({
    title: 'Suicide rates among CRPS patients',
    abstract: '',
  }, {}, { injectedModel: mockModel });
  assert.equal(r.tier, 3);
  assert.equal(r.blocked_by, 'pre_filter');
  assert.equal(r.block_reason, 'suicide_keyword');
  assert.equal(llmCalled, false, 'LLM must not be called when pre-filter blocks');
});

test('pre-filter passes — LLM tier 1 result surfaces', async () => {
  const mockModel = makeMockModel({ tier: 1, rationale: 'new positive RCT' });
  const r = await classifyArticle({
    title: 'Phase 2 RCT: low-dose naltrexone reduces CRPS pain',
    abstract: 'Positive results in 80 patients.',
  }, {}, { injectedModel: mockModel });
  assert.equal(r.tier, 1);
  assert.equal(r.blocked_by, null);
  assert.equal(r.framing_he, null);
  assert.equal(r.block_reason, null);
  assert.equal(r.classifier_rationale, 'new positive RCT');
});

test('pre-filter passes — LLM tier 2 result returns framing_he', async () => {
  const mockModel = makeMockModel({
    tier: 2, rationale: 'mixed results', framing_he: 'תוצאות מעורבות; מחצית המשתתפים הגיבו',
  });
  const r = await classifyArticle({
    title: 'Mixed results for ketamine in CRPS',
    abstract: '',
  }, {}, { injectedModel: mockModel });
  assert.equal(r.tier, 2);
  assert.equal(r.blocked_by, null);
  assert.equal(r.framing_he, 'תוצאות מעורבות; מחצית המשתתפים הגיבו');
});

test('pre-filter passes — LLM tier 3 marks blocked_by="llm_classifier"', async () => {
  const mockModel = makeMockModel({
    tier: 3, rationale: 'graphic prognosis', block_reason: 'tier3_prognosis',
  });
  const r = await classifyArticle({
    title: 'Long-term outcomes — neutral wording but content fits Tier 3',
    abstract: 'Detailed pessimistic prognosis description.',
  }, {}, { injectedModel: mockModel });
  assert.equal(r.tier, 3);
  assert.equal(r.blocked_by, 'llm_classifier');
  assert.equal(r.block_reason, 'tier3_prognosis');
});

test('LLM JSON parse failure → failsafe tier 3, blocked_by="llm_classifier"', async () => {
  const mockModel = makeMockModel('not-json {{');
  const r = await classifyArticle({
    title: 'Some neutral CRPS article',
    abstract: '',
  }, {}, { injectedModel: mockModel });
  assert.equal(r.tier, 3);
  assert.equal(r.blocked_by, 'llm_classifier');
  assert.equal(r.block_reason, 'schema_violation');
});

test('userProfile is passed to classifier (treatment context)', async () => {
  let captured = null;
  const mockModel = {
    async generateContent(prompt) {
      captured = prompt;
      return {
        response: {
          text: () => JSON.stringify({ tier: 1, rationale: 'ok' }),
          usageMetadata: {},
        },
      };
    },
  };
  await classifyArticle({
    title: 'CRPS research',
    abstract: '',
  }, {
    profile_he: 'מטופל DRG מאז 2018',
    treatments: ['DRG', 'gabapentin'],
  }, { injectedModel: mockModel });
  assert.match(captured, /DRG, gabapentin/);
  assert.match(captured, /מטופל DRG מאז 2018/);
});
