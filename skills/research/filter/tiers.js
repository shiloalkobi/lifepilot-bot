'use strict';

/**
 * Hope Filter orchestrator.
 * Runs an article through the two-stage pipeline:
 *   1. Deterministic pre-filter (filter/keywords.js) — fast, no LLM cost.
 *   2. LLM classifier (filter/classifier.js) — Gemini 2.5 Flash.
 *
 * Returns a normalized result that 4d's storage layer writes either to
 * `research_articles` (tier 1/2) or `research_blocked_log` (tier 3).
 *
 * Output shape:
 *   {
 *     tier:                 1 | 2 | 3,
 *     framing_he:           string | null,    // present iff tier=2
 *     block_reason:         string | null,    // present iff tier=3
 *     classifier_rationale: string,           // always present, English, debug
 *     blocked_by:           'pre_filter' | 'llm_classifier' | null,
 *   }
 */

const { applyPreFilter } = require('./keywords');
const classifier = require('./classifier');

async function classifyArticle(article, userProfile = {}, opts = {}) {
  // Stage 1: deterministic pre-filter — short-circuit on match.
  const pre = applyPreFilter(article);
  if (pre.blocked) {
    return {
      tier:                 3,
      framing_he:           null,
      block_reason:         pre.reason_code,
      classifier_rationale: `Pre-filter rule "${pre.rule_id}" matched`,
      blocked_by:           'pre_filter',
    };
  }

  // Stage 2: LLM classifier.
  const result = await classifier.classify(article, userProfile, opts.injectedModel || null);

  return {
    tier:                 result.tier,
    framing_he:           result.framing_he,
    block_reason:         result.block_reason,
    classifier_rationale: result.rationale,
    blocked_by:           result.tier === 3 ? 'llm_classifier' : null,
    _tokens:              result._tokens,
    _failsafe:            !!result._failsafe,
  };
}

module.exports = { classifyArticle };
