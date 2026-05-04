'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cls = require('../skills/research/filter/classifier');
const { buildUserPrompt, validateAndCoerce, failsafe, classify, SYSTEM_PROMPT } = cls;

test('SYSTEM_PROMPT includes core constraints from 01b §6.3', () => {
  // Spot-check key clauses that MUST appear (prompt is APPROVED — no edits).
  assert.match(SYSTEM_PROMPT, /emotional-safety classifier for CRPS/);
  assert.match(SYSTEM_PROMPT, /Tier 3 = block. Tier 1 = surface. Tier 2 = surface with neutral framing/);
  assert.match(SYSTEM_PROMPT, /never block these/);
  assert.match(SYSTEM_PROMPT, /framing_he.*Hebrew/);
});

test('buildUserPrompt formats all fields', () => {
  const prompt = buildUserPrompt({
    title: 't', abstract: 'a', source: 'pubmed', published_at: '2026-01-01',
  }, {
    profile_he: 'CRPS since 2018', treatments: ['DRG', 'gabapentin'],
  });
  assert.match(prompt, /Title: t/);
  assert.match(prompt, /Abstract: a/);
  assert.match(prompt, /Source: pubmed/);
  assert.match(prompt, /Published: 2026-01-01/);
  assert.match(prompt, /CRPS since 2018/);
  assert.match(prompt, /DRG, gabapentin/);
  assert.match(prompt, /\nClassify\.$/);
});

test('buildUserPrompt handles missing optional fields gracefully', () => {
  const prompt = buildUserPrompt({ title: 't' }, {});
  assert.match(prompt, /Abstract: \(none\)/);
  assert.match(prompt, /User profile.*: \(none\)/);
  assert.match(prompt, /User current treatments: \(none\)/);
});

test('failsafe returns tier 3 with schema_violation', () => {
  const r = failsafe('test reason');
  assert.equal(r.tier, 3);
  assert.equal(r.framing_he, null);
  assert.equal(r.block_reason, 'schema_violation');
  assert.match(r.rationale, /^Failsafe: test reason/);
  assert.equal(r._failsafe, true);
});

test('validateAndCoerce: tier 1 must have null framing_he and block_reason', () => {
  const r = validateAndCoerce({ tier: 1, rationale: 'positive new treatment data' });
  assert.equal(r.tier, 1);
  assert.equal(r.framing_he, null);
  assert.equal(r.block_reason, null);
  assert.equal(r.rationale, 'positive new treatment data');
});

test('validateAndCoerce: tier 1 with framing_he is failsafe', () => {
  const r = validateAndCoerce({ tier: 1, rationale: 'ok', framing_he: 'extra' });
  assert.equal(r.tier, 3);
  assert.equal(r.block_reason, 'schema_violation');
});

test('validateAndCoerce: tier 2 requires non-empty framing_he', () => {
  const ok = validateAndCoerce({ tier: 2, rationale: 'mixed', framing_he: 'תוצאות מעורבות, מחקר ראשוני' });
  assert.equal(ok.tier, 2);
  assert.equal(ok.framing_he, 'תוצאות מעורבות, מחקר ראשוני');

  const fail = validateAndCoerce({ tier: 2, rationale: 'mixed', framing_he: '' });
  assert.equal(fail.tier, 3, 'empty framing_he should failsafe');
});

test('validateAndCoerce: tier 3 requires non-empty block_reason', () => {
  const ok = validateAndCoerce({ tier: 3, rationale: 'forum anecdote', block_reason: 'tier3_anecdote' });
  assert.equal(ok.tier, 3);
  assert.equal(ok.block_reason, 'tier3_anecdote');

  const fail = validateAndCoerce({ tier: 3, rationale: 'no reason' });
  assert.equal(fail.tier, 3);
  assert.equal(fail.block_reason, 'schema_violation');
});

test('validateAndCoerce: invalid tier value → failsafe', () => {
  assert.equal(validateAndCoerce({ tier: 0, rationale: 'x' }).block_reason, 'schema_violation');
  assert.equal(validateAndCoerce({ tier: 4, rationale: 'x' }).block_reason, 'schema_violation');
  assert.equal(validateAndCoerce({ tier: '1', rationale: 'x' }).block_reason, 'schema_violation');
});

test('validateAndCoerce: missing rationale → failsafe', () => {
  assert.equal(validateAndCoerce({ tier: 1 }).block_reason, 'schema_violation');
  assert.equal(validateAndCoerce({ tier: 1, rationale: '' }).block_reason, 'schema_violation');
});

test('validateAndCoerce: rationale too long → failsafe', () => {
  const r = validateAndCoerce({ tier: 1, rationale: 'x'.repeat(201) });
  assert.equal(r.block_reason, 'schema_violation');
});

test('validateAndCoerce: framing_he too long (tier 2) → failsafe', () => {
  const r = validateAndCoerce({ tier: 2, rationale: 'mixed', framing_he: 'x'.repeat(201) });
  assert.equal(r.block_reason, 'schema_violation');
});

test('validateAndCoerce: block_reason too long (tier 3) → failsafe', () => {
  const r = validateAndCoerce({ tier: 3, rationale: 'mixed', block_reason: 'x'.repeat(81) });
  assert.equal(r.block_reason, 'schema_violation');
});

test('validateAndCoerce: not an object → failsafe', () => {
  assert.equal(validateAndCoerce(null).block_reason, 'schema_violation');
  assert.equal(validateAndCoerce('hi').block_reason, 'schema_violation');
  assert.equal(validateAndCoerce(42).block_reason, 'schema_violation');
});

test('classify with injected mock model: tier 1 happy path', async () => {
  const mockModel = {
    async generateContent(_prompt) {
      return {
        response: {
          text: () => JSON.stringify({ tier: 1, rationale: 'positive new treatment data' }),
          usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 80, totalTokenCount: 680 },
        },
      };
    },
  };
  const r = await classify({ title: 't', source: 'pubmed' }, {}, mockModel);
  assert.equal(r.tier, 1);
  assert.equal(r._tokens.total, 680);
});

test('classify with injected mock model: malformed JSON → failsafe tier 3', async () => {
  const mockModel = {
    async generateContent() {
      return { response: { text: () => 'not-json {{{', usageMetadata: {} } };
    },
  };
  const r = await classify({ title: 't', source: 'pubmed' }, {}, mockModel);
  assert.equal(r.tier, 3);
  assert.equal(r.block_reason, 'schema_violation');
  assert.match(r.rationale, /JSON parse error/);
});

test('classify with injected mock model: empty response → failsafe', async () => {
  const mockModel = {
    async generateContent() {
      return { response: { text: () => '', usageMetadata: {} } };
    },
  };
  const r = await classify({ title: 't', source: 'pubmed' }, {}, mockModel);
  assert.equal(r.tier, 3);
  assert.match(r.rationale, /empty response/);
});

test('classify with injected mock model: transport error re-thrown', async () => {
  const mockModel = {
    async generateContent() { throw new Error('network down'); },
  };
  await assert.rejects(
    classify({ title: 't', source: 'pubmed' }, {}, mockModel),
    /Gemini transport error: network down/,
  );
});
