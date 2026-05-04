'use strict';

/**
 * Hope Filter — Stage 2: Gemini 2.5 Flash classifier.
 * Prompt is verbatim per docs/research/01b §6.3 (APPROVED — do not modify).
 * JSON schema validation per 01b §6.4 with fail-safe coercion to tier 3.
 *
 * Uses the same direct-instantiation pattern as bot/doc-summary.js,
 * bot/notes.js, bot/news.js, bot/reminders.js, bot/claude.js — there is
 * no central Gemini client wrapper in this project; every consumer
 * instantiates its own. `@google/generative-ai` is already a project
 * dependency — no new packages added.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Lazy init so that `require()` doesn't crash if GEMINI_API_KEY is unset
// at startup (e.g., during unit tests). Caller-time errors are clearer.
let _genAI = null;
function getModel() {
  if (!_genAI) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set; classifier cannot run');
    }
    _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature:      0,
      responseMimeType: 'application/json',
    },
  });
}

const SYSTEM_PROMPT =
`You are an emotional-safety classifier for CRPS (Complex Regional Pain Syndrome)
research articles. Your output decides whether a chronic-pain patient sees an
article. Mistakes have real impact: surfacing scary content harms; over-blocking
hides hope. Be conservative when uncertain.

CONSTRAINTS (non-negotiable):
- Tier 3 = block. Tier 1 = surface. Tier 2 = surface with neutral framing.
- Tier 3 covers: prognosis pessimism, disability/mortality stats, suicide content,
  graphic pain descriptions, "most painful condition" framing, patient anecdotes
  from forums, content focused on side effects without the user asking.
- Tier 1 covers: new treatment positive results, recruiting clinical trials
  (especially in Israel), mechanism breakthroughs, regulatory approvals, positive
  remission/quality-of-life data, publications by tracked CRPS researchers.
- Tier 2 covers: mixed results, early-phase data, treatments with caveats,
  general reviews. Articles that challenge a treatment the user takes also go
  here with neutral framing — never block these.

LANGUAGE:
- "framing_he" must be Hebrew, ≤ 25 words, warm-but-honest tone.
- "rationale" must be English, ≤ 15 words, for internal logging.

OUTPUT (JSON only — no prose, no markdown fence):
{
  "tier": 1 | 2 | 3,
  "framing_he": "string | null",      // present iff tier=2
  "block_reason": "string | null",    // present iff tier=3, short stable code
  "rationale": "string"                // always present
}`;

function buildUserPrompt(article, profile) {
  const treatments = Array.isArray(profile && profile.treatments)
    ? profile.treatments.join(', ')
    : '(none)';
  const profileHe = (profile && profile.profile_he) ? profile.profile_he : '(none)';
  return [
    `Title: ${article.title || '(no title)'}`,
    `Abstract: ${article.abstract || '(none)'}`,
    `Source: ${article.source || '(unknown)'}`,
    `Published: ${article.published_at || '(unknown)'}`,
    `User profile (for context — do NOT echo): ${profileHe}`,
    `User current treatments: ${treatments}`,
    '',
    'Classify.',
  ].join('\n');
}

function failsafe(reason) {
  return {
    tier:         3,
    framing_he:   null,
    block_reason: 'schema_violation',
    rationale:    `Failsafe: ${String(reason).slice(0, 180)}`,
    _failsafe:    true,
  };
}

/**
 * Validate Gemini response against 01b §6.4 schema and per-tier constraints.
 * Any violation → coerce to tier 3 with block_reason='schema_violation'.
 */
function validateAndCoerce(obj) {
  if (typeof obj !== 'object' || obj === null) return failsafe('not an object');

  const tier = obj.tier;
  if (tier !== 1 && tier !== 2 && tier !== 3) return failsafe('tier not in {1,2,3}');

  const rationale = obj.rationale;
  if (typeof rationale !== 'string' || !rationale.trim().length) return failsafe('rationale missing');
  if (rationale.length > 200) return failsafe('rationale too long');

  if (tier === 1) {
    // framing_he and block_reason should be absent or null
    const fr = obj.framing_he;
    const br = obj.block_reason;
    if (fr != null && String(fr).trim().length > 0) return failsafe('tier 1 must not have framing_he');
    if (br != null && String(br).trim().length > 0) return failsafe('tier 1 must not have block_reason');
    return { tier: 1, framing_he: null, block_reason: null, rationale: rationale.trim() };
  }

  if (tier === 2) {
    const fr = obj.framing_he;
    if (typeof fr !== 'string' || !fr.trim().length) return failsafe('tier 2 requires non-empty framing_he');
    if (fr.length > 200) return failsafe('framing_he too long');
    return { tier: 2, framing_he: fr.trim(), block_reason: null, rationale: rationale.trim() };
  }

  // tier === 3
  const br = obj.block_reason;
  if (typeof br !== 'string' || !br.trim().length) return failsafe('tier 3 requires non-empty block_reason');
  if (br.length > 80) return failsafe('block_reason too long');
  return { tier: 3, framing_he: null, block_reason: br.trim(), rationale: rationale.trim() };
}

/**
 * Classify a single article via Gemini. Returns the validated result;
 * never throws on schema violations (fail-safes to tier 3 instead).
 * Throws only on transport/auth errors.
 */
async function classify(article, profile = {}, injectedModel = null) {
  const model = injectedModel || getModel();
  const userPrompt = buildUserPrompt(article, profile);

  let result;
  try {
    result = await model.generateContent(userPrompt);
  } catch (err) {
    // Transport error — re-throw so caller can decide retry/skip.
    throw new Error(`Gemini transport error: ${err.message}`);
  }

  const text = result?.response?.text?.() || '';
  if (!text) return failsafe('empty response');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return failsafe(`JSON parse error: ${err.message}`);
  }

  const validated = validateAndCoerce(parsed);

  // Token budget observability (per 01b §6.5 target ~730 tokens/article).
  const usage = result?.response?.usageMetadata || {};
  validated._tokens = {
    prompt:     usage.promptTokenCount     || null,
    candidates: usage.candidatesTokenCount || null,
    total:      usage.totalTokenCount      || null,
  };

  return validated;
}

module.exports = {
  classify,
  buildUserPrompt,
  validateAndCoerce,
  failsafe,
  SYSTEM_PROMPT,
};
