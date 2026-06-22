'use strict';

/**
 * flight skill — Disability Flight Companion (owner-only).
 *
 * Two parts (per docs/flight-companion-design.md + docs/flight-companion-prd.md):
 *
 *   Part A — Pre-flight prep (static, 0 LLM tokens):
 *     execute('flight_section', { section }, ctx) returns a JSON STRING with the
 *     researched HE+EN content from ./content.js (checklist, docs, wheelchair,
 *     rights, security, phrases). Unknown/empty section → the menu. Pure data,
 *     no network, no LLM. Mirrors the /research direct-execute contract
 *     (bot/telegram.js:596 — typeof raw === 'string' ? JSON.parse).
 *
 *   Part B — Live voice help (≤1 Gemini call/note), bidirectional (v2):
 *     transcribeFlightVoice(fileUrl) downloads a Telegram voice note and asks
 *     Gemini to detect the spoken language, transcribe VERBATIM in that original
 *     language, then translate to the OPPOSITE language (English→Hebrew /
 *     Hebrew→English) — one generateContent call, multilingual (NOT
 *     Hebrew-locked). Returns { transcript_verbatim, translation, detected_lang,
 *     translated_to }. translated_to is 'en' when Hebrew was spoken, otherwise
 *     'he' (ambiguous/unknown detected_lang defaults to 'he', preserving the v1
 *     English→Hebrew behavior). This is a SEPARATE function from
 *     skills/voice/index.js transcribeVoice (STOP-list); that Hebrew path is
 *     never imported, edited, or wrapped here.
 *
 * `tools: []` — registers ZERO agent tools (mirrors skills/voice/index.js:13),
 * so the loader (bot/skills-registry.js:42-65) registers nothing and the
 * feature consumes zero ReAct/LLM budget. transcribeFlightVoice and execute are
 * require()-d directly from bot/telegram.js, just like transcribeVoice is.
 */

const https = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const {
  DISCLAIMER_HE,
  DISCLAIMER_EN,
  MEDICAL_LEGAL_SECTIONS,
  SECTIONS,
  MENU_HE,
} = require('./content');

const name        = 'flight';
const description = 'Disability flight companion — pre-flight info (HE+EN) + live voice translate.';
const tools       = []; // intercepted at telegram.js level — no agent tools registered

// ── Part A — static section lookup (0 LLM tokens) ─────────────────────────────

/**
 * Build the menu return object (used for both `/flight` and unknown/empty
 * sections). Pure data — no disclaimer, no network.
 */
function menuObject() {
  return { ok: true, section: 'menu', body_he: MENU_HE };
}

/**
 * Look up a Part A section and return its content object. Unknown/empty
 * section → the menu object (graceful, never throws). When the matched
 * section's needs_disclaimer is true, disclaimer_he/disclaimer_en are already
 * co-located inside the content constant (see content.js) and are passed
 * through verbatim — the caller appends them when needs_disclaimer === true.
 *
 * @param {string|undefined} section
 * @returns {object} content object (synchronous, pure)
 */
function lookupSection(section) {
  const key = typeof section === 'string' ? section.trim().toLowerCase() : '';
  const found = key && Object.prototype.hasOwnProperty.call(SECTIONS, key)
    ? SECTIONS[key]
    : null;
  if (!found) return menuObject();
  return Object.assign({ ok: true }, found);
}

// ── Flight-mode state (Part B toggle) ─────────────────────────────────────────
// In-memory only (no disk/DB) — Q5/B1.1. Maps chatId(string) -> expiry epoch ms.
// Auto-expires 3h after the last /flight_on (B3.1). Lazy expiry check at read
// time (B3.3) — no timer/cron. Kept here (not telegram.js) so the OFF-mode
// routing predicate is unit-testable in isolation, keeping telegram.js thin.

const FLIGHT_MODE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

const _flightMode = new Map(); // chatId(string) -> expiry epoch ms

/** Turn flight mode ON for a chat; (re)starts the 3-hour clock. */
function setFlightMode(chatId, on, now = Date.now()) {
  const key = String(chatId);
  if (on) {
    _flightMode.set(key, now + FLIGHT_MODE_TTL_MS);
  } else {
    _flightMode.delete(key);
  }
}

/**
 * Is flight mode currently ON for this chat? Treats an expired entry as OFF
 * and prunes it. This is the routing predicate the voice handler consults
 * before choosing transcribeFlightVoice vs the existing transcribeVoice path.
 */
function isFlightMode(chatId, now = Date.now()) {
  const key = String(chatId);
  const expiry = _flightMode.get(key);
  if (expiry === undefined) return false;
  if (now >= expiry) {
    _flightMode.delete(key);
    return false;
  }
  return true;
}

// ── Download helper (Part B) ──────────────────────────────────────────────────
// Independent copy of the voice download semantics — skills/voice is NOT
// imported (STOP-list). Follows one redirect, buffers the body.

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Part B — verbatim multilingual transcribe + bidirectional translation ─────

// Multilingual, direction-NEUTRAL (NOT Hebrew-locked) system instruction.
// Mirrors the Gemini-audio call mechanics of skills/voice/index.js but asks for
// a delimited two-field response: verbatim original (any language) + translation
// into the OPPOSITE language. No summarising, no answering, no added content.
const FLIGHT_SYSTEM_INSTRUCTION =
  'You are a verbatim multilingual transcription and translation service. ' +
  'Detect the spoken language. Transcribe exactly what is said in its original ' +
  'spoken language, word for word. Then translate that transcription into the ' +
  'OPPOSITE language: if the speech is English, translate to Hebrew; if the ' +
  'speech is Hebrew, translate to English. ' +
  'Do not summarise, do not answer, do not add or omit any content.';

const FLIGHT_PROMPT =
  'Detect the spoken language, transcribe this audio verbatim in that original ' +
  'language, then translate it to the OPPOSITE language.\n' +
  'Reply in EXACTLY this format, nothing else:\n' +
  'LANG: <ISO language code or language name of the original speech>\n' +
  'VERBATIM: <the exact words spoken, in the original language>\n' +
  'TRANSLATION: <the translation in the OPPOSITE language of LANG — Hebrew if LANG is English, English if LANG is Hebrew>';

/**
 * Decide the translation target language from the detected source language.
 * Hebrew was spoken → translation is English ('en'). Anything else (English or
 * ambiguous/unknown) → translation is Hebrew ('he'), preserving v1 behavior.
 * Robust to ISO codes and language names: 'he','heb','hebrew','iw','עברית'.
 *
 * @param {string} detectedLang
 * @returns {'en'|'he'}
 */
function deriveTranslatedTo(detectedLang) {
  const l = String(detectedLang || '').trim().toLowerCase();
  const isHebrew = /^(he|heb|hebrew|iw)\b/.test(l)
    || l === 'he-il'
    || /\bhebrew\b/.test(l)
    || /[֐-׿]/.test(detectedLang || ''); // Hebrew script in the label itself
  return isHebrew ? 'en' : 'he';
}

/**
 * Parse Gemini's delimited response into the fields. On parse failure (e.g.
 * only one block returned) the raw text is preserved in transcript_verbatim and
 * translation is left empty — content is never dropped (C2.1 / design §3.3).
 * The caller notes that translation couldn't be separated.
 *
 * translated_to is derived from detected_lang: Hebrew spoken → 'en', otherwise
 * 'he' (ambiguous/unknown defaults to 'he', preserving v1 English→Hebrew).
 *
 * @param {string} raw
 * @returns {{ transcript_verbatim: string, translation: string, detected_lang: string, translated_to: 'en'|'he' }}
 */
function parseFlightResponse(raw) {
  const text = (raw || '').trim();

  const langMatch        = text.match(/^\s*LANG:\s*(.*)$/im);
  const verbatimMatch    = text.match(/VERBATIM:\s*([\s\S]*?)(?:\n\s*TRANSLATION:|$)/i);
  const translationMatch = text.match(/TRANSLATION:\s*([\s\S]*)$/i);

  const verbatim    = verbatimMatch    ? verbatimMatch[1].trim()    : '';
  const translation = translationMatch ? translationMatch[1].trim() : '';
  const lang        = langMatch        ? langMatch[1].trim()        : '';
  const translatedTo = deriveTranslatedTo(lang);

  // Clean two-field parse succeeded.
  if (verbatim && translation) {
    return { transcript_verbatim: verbatim, translation, detected_lang: lang, translated_to: translatedTo };
  }

  // Fallback: only one usable block (or unstructured output). Never drop
  // content — surface the raw model text as the verbatim original and signal
  // (empty translation) that the translation couldn't be separated.
  const fallback = verbatim || translation || text;
  return { transcript_verbatim: fallback, translation: '', detected_lang: lang, translated_to: translatedTo };
}

/**
 * Download a Telegram voice file and transcribe-verbatim + translate to the
 * OPPOSITE language (English↔Hebrew, auto-detected) via ONE Gemini
 * generateContent call.
 *
 * Designed so the 2-call fallback (verbatim call + translate call) is an
 * internal swap later: the signature and return shape stay identical —
 * transcribeFlightVoice(fileUrl) -> { transcript_verbatim, translation,
 * detected_lang, translated_to } — so bot/telegram.js never changes (C6.2).
 *
 * @param {string} fileUrl  Full Telegram file URL (includes bot token)
 * @returns {Promise<{ transcript_verbatim: string, translation: string, detected_lang: string, translated_to: 'en'|'he' }>}
 * @throws on download/Gemini failure (caller maps to the Hebrew error message)
 */
async function transcribeFlightVoice(fileUrl) {
  console.log('[Skills] flight: downloading audio...');
  const buffer = await downloadBuffer(fileUrl);
  const base64 = buffer.toString('base64');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model:             'gemini-3-flash-preview',
    systemInstruction: FLIGHT_SYSTEM_INSTRUCTION,
  });

  // ONE call: verbatim (original language) + Hebrew translation.
  const result = await model.generateContent([
    { text: FLIGHT_PROMPT },
    { inlineData: { mimeType: 'audio/ogg', data: base64 } },
  ]);

  return parseFlightResponse(result.response.text());
}

// ── Skill execute() contract ──────────────────────────────────────────────────

/**
 * Part A entry point. Returns a JSON STRING (matching the /research
 * `typeof raw === 'string' ? JSON.parse` convention at bot/telegram.js:596).
 * ZERO LLM calls — pure synchronous data return wrapped in a resolved promise.
 */
async function execute(toolName, args, _ctx) {
  if (toolName === 'flight_section') {
    const section = args && typeof args === 'object' ? args.section : undefined;
    return JSON.stringify(lookupSection(section));
  }
  return `Unknown tool "${toolName}" in skill "${name}"`;
}

module.exports = {
  name,
  description,
  tools,
  execute,
  transcribeFlightVoice,
  // flight-mode state (Part B toggle) — in-memory, 3h auto-expire
  setFlightMode,
  isFlightMode,
  FLIGHT_MODE_TTL_MS,
  // internals exposed for unit tests (no network/LLM)
  _internals: {
    lookupSection,
    menuObject,
    parseFlightResponse,
    deriveTranslatedTo,
    DISCLAIMER_HE,
    DISCLAIMER_EN,
    MEDICAL_LEGAL_SECTIONS,
    SECTIONS,
    MENU_HE,
    FLIGHT_SYSTEM_INSTRUCTION,
  },
};
