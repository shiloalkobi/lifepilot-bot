'use strict';

/**
 * Disability Flight Companion — skill unit tests.
 *
 * Pure, no-network, no-LLM. Covers (per docs/flight-companion-prd.md):
 *   - Part A disclaimer invariant (A4.1/A4.2/NFR-2)
 *   - execute('flight_section') content + menu fallback + 0-token contract (A2)
 *   - flight-mode OFF-mode routing predicate + 3h auto-expire (B3, C5)
 *   - transcribeFlightVoice response parsing incl. fallback (C2.1)
 *
 * Framework: node:test + node:assert/strict (matches existing tests/).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const skill = require('../skills/flight');
const {
  lookupSection,
  menuObject,
  parseFlightResponse,
  deriveTranslatedTo,
  MEDICAL_LEGAL_SECTIONS,
  SECTIONS,
  MENU_HE,
} = skill._internals;

// ── export shape ──────────────────────────────────────────────────────────────

test('skill exports the contract shape', () => {
  assert.equal(skill.name, 'flight');
  assert.equal(typeof skill.description, 'string');
  assert.ok(Array.isArray(skill.tools));
  assert.equal(skill.tools.length, 0, 'tools must be empty → zero agent tools registered');
  assert.equal(typeof skill.execute, 'function');
  assert.equal(typeof skill.transcribeFlightVoice, 'function');
  assert.equal(typeof skill.setFlightMode, 'function');
  assert.equal(typeof skill.isFlightMode, 'function');
});

// ── Part A — disclaimer invariant (NFR-2 / A4.1 / A4.2) ─────────────────────────

test('every MEDICAL_LEGAL_SECTIONS entry forces a non-empty HE+EN disclaimer', () => {
  assert.deepEqual(
    [...MEDICAL_LEGAL_SECTIONS].sort(),
    ['docs', 'rights', 'security', 'wheelchair'],
    'the locked Q8 set is rights+security+wheelchair+docs',
  );
  for (const key of MEDICAL_LEGAL_SECTIONS) {
    const sec = SECTIONS[key];
    assert.ok(sec, `section "${key}" must exist`);
    assert.equal(sec.needs_disclaimer, true, `section "${key}" must set needs_disclaimer === true`);
    assert.equal(typeof sec.disclaimer_he, 'string');
    assert.equal(typeof sec.disclaimer_en, 'string');
    assert.ok(sec.disclaimer_he.trim().length > 0, `section "${key}" disclaimer_he must be non-empty`);
    assert.ok(sec.disclaimer_en.trim().length > 0, `section "${key}" disclaimer_en must be non-empty`);
  }
});

test('non-medical sections (checklist, phrases) do NOT force the disclaimer', () => {
  for (const key of ['checklist', 'phrases']) {
    assert.notEqual(SECTIONS[key].needs_disclaimer, true, `section "${key}" must not force disclaimer`);
    assert.ok(!MEDICAL_LEGAL_SECTIONS.includes(key));
  }
});

// ── Part A — execute('flight_section') (A2) ─────────────────────────────────────

test('execute returns a JSON string (the /research typeof-guard contract)', async () => {
  const raw = await skill.execute('flight_section', { section: 'rights' }, { chat_id: 1 });
  assert.equal(typeof raw, 'string', 'execute must return a JSON STRING, not an object');
  const parsed = JSON.parse(raw); // must not throw
  assert.equal(parsed.ok, true);
});

test('each valid section returns ok:true with correct title/body from content.js', async () => {
  for (const key of Object.keys(SECTIONS)) {
    const parsed = JSON.parse(await skill.execute('flight_section', { section: key }, {}));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.section, key);
    assert.equal(parsed.title_he, SECTIONS[key].title_he);
    assert.equal(parsed.body_he, SECTIONS[key].body_he);
    if (SECTIONS[key].needs_disclaimer) {
      assert.equal(parsed.needs_disclaimer, true);
      assert.equal(parsed.disclaimer_he, SECTIONS[key].disclaimer_he);
      assert.equal(parsed.disclaimer_en, SECTIONS[key].disclaimer_en);
    }
  }
});

test('section matching is case-insensitive and whitespace-tolerant', async () => {
  const parsed = JSON.parse(await skill.execute('flight_section', { section: '  Rights ' }, {}));
  assert.equal(parsed.section, 'rights');
});

test('unknown section returns the menu gracefully (A2.3)', async () => {
  const parsed = JSON.parse(await skill.execute('flight_section', { section: 'banana' }, {}));
  assert.deepEqual(parsed, { ok: true, section: 'menu', body_he: MENU_HE });
});

test('empty / missing section returns the menu (A1, A2.3)', async () => {
  for (const args of [{ section: '' }, { section: undefined }, {}, undefined]) {
    const parsed = JSON.parse(await skill.execute('flight_section', args, {}));
    assert.equal(parsed.section, 'menu');
    assert.equal(parsed.body_he, MENU_HE);
  }
});

test('unknown tool name returns the standard miss string', async () => {
  const out = await skill.execute('not_a_tool', {}, {});
  assert.match(out, /Unknown tool/);
});

// ── 0-token / no-network proof (A1.4 / A2.4 / NFR-1) ────────────────────────────

test('lookupSection is pure & synchronous — no fetch/LLM possible', () => {
  // Trip any accidental network use: if lookupSection awaited a network call it
  // could not return a plain object synchronously. Assert sync + no global fetch
  // touched. (transcribeFlightVoice is the ONLY function allowed network access.)
  const before = global.fetch;
  let fetchCalled = false;
  global.fetch = () => { fetchCalled = true; throw new Error('no network allowed in Part A'); };
  try {
    const out = lookupSection('security');
    assert.equal(typeof out, 'object');
    assert.equal(out.ok, true);
    assert.equal(out.section, 'security');
    assert.equal(fetchCalled, false, 'Part A must not hit the network → 0 tokens');
  } finally {
    global.fetch = before;
  }
});

test('menuObject is the canonical menu shape', () => {
  assert.deepEqual(menuObject(), { ok: true, section: 'menu', body_he: MENU_HE });
});

// ── Flight-mode state: OFF-mode routing + auto-expire (B3 / C5) ──────────────────

test('flight mode defaults OFF → voice routing chooses the existing path', () => {
  const chat = 'off-mode-default-chat';
  skill.setFlightMode(chat, false);
  assert.equal(skill.isFlightMode(chat), false,
    'OFF → telegram.js skips transcribeFlightVoice and falls through to transcribeVoice');
});

test('setFlightMode(on) flips the routing predicate ON, off flips it back', () => {
  const chat = 'toggle-chat';
  skill.setFlightMode(chat, true);
  assert.equal(skill.isFlightMode(chat), true);
  skill.setFlightMode(chat, false);
  assert.equal(skill.isFlightMode(chat), false);
});

test('flight mode is keyed by chat id (string-normalised) — isolation', () => {
  skill.setFlightMode(111, true);
  assert.equal(skill.isFlightMode('111'), true, 'numeric and string chat ids resolve to the same entry');
  assert.equal(skill.isFlightMode(222), false);
  skill.setFlightMode(111, false);
});

test('flight mode auto-expires after 3h (B3.1) and reads as OFF (B3.2)', () => {
  const chat = 'expiry-chat';
  const t0 = 1_000_000;
  skill.setFlightMode(chat, true, t0);
  assert.equal(skill.isFlightMode(chat, t0 + 1000), true, 'still ON within the window');
  assert.equal(skill.isFlightMode(chat, t0 + skill.FLIGHT_MODE_TTL_MS - 1), true, 'ON just before TTL');
  assert.equal(skill.isFlightMode(chat, t0 + skill.FLIGHT_MODE_TTL_MS), false, 'OFF at exactly TTL');
  assert.equal(skill.isFlightMode(chat, t0 + skill.FLIGHT_MODE_TTL_MS + 1), false, 'OFF after TTL');
});

test('each /flight_on resets the 3-hour clock (B3.3)', () => {
  const chat = 'reset-chat';
  const t0 = 5_000_000;
  skill.setFlightMode(chat, true, t0);
  // Re-arm later — expiry should be measured from the new on-time.
  const t1 = t0 + skill.FLIGHT_MODE_TTL_MS - 10;
  skill.setFlightMode(chat, true, t1);
  assert.equal(skill.isFlightMode(chat, t0 + skill.FLIGHT_MODE_TTL_MS + 5), true,
    'past the FIRST window but still inside the re-armed window');
  skill.setFlightMode(chat, false);
});

test('FLIGHT_MODE_TTL_MS is exactly 3 hours', () => {
  assert.equal(skill.FLIGHT_MODE_TTL_MS, 3 * 60 * 60 * 1000);
});

// ── Part B — response parsing (C1.2 / C2.1) ─────────────────────────────────────

test('parseFlightResponse splits the delimited two-field response (EN→HE)', () => {
  const raw = 'LANG: en\nVERBATIM: Please go to gate 12.\nTRANSLATION: אנא לך לשער 12.';
  const out = parseFlightResponse(raw);
  assert.equal(out.detected_lang, 'en');
  assert.equal(out.transcript_verbatim, 'Please go to gate 12.');
  assert.equal(out.translation, 'אנא לך לשער 12.');
  assert.equal(out.translated_to, 'he', 'English spoken → translate to Hebrew');
});

test('parseFlightResponse handles the Hebrew→English direction (v2)', () => {
  const raw = 'LANG: he\nVERBATIM: אנא לך לשער 12.\nTRANSLATION: Please go to gate 12.';
  const out = parseFlightResponse(raw);
  assert.equal(out.detected_lang, 'he');
  assert.equal(out.transcript_verbatim, 'אנא לך לשער 12.');
  assert.equal(out.translation, 'Please go to gate 12.');
  assert.equal(out.translated_to, 'en', 'Hebrew spoken → translate to English');
});

test('parseFlightResponse derives translated_to=en for Hebrew label variants', () => {
  for (const label of ['he', 'heb', 'Hebrew', 'HEBREW', 'iw', 'עברית', 'he-IL']) {
    const raw = `LANG: ${label}\nVERBATIM: שלום.\nTRANSLATION: Hello.`;
    const out = parseFlightResponse(raw);
    assert.equal(out.translated_to, 'en', `label "${label}" must derive translated_to=en`);
  }
});

test('parseFlightResponse derives translated_to=he for English label variants', () => {
  for (const label of ['en', 'eng', 'English', 'EN', 'en-US']) {
    const raw = `LANG: ${label}\nVERBATIM: Hello.\nTRANSLATION: שלום.`;
    const out = parseFlightResponse(raw);
    assert.equal(out.translated_to, 'he', `label "${label}" must derive translated_to=he`);
  }
});

test('parseFlightResponse defaults ambiguous/unknown detected_lang to he (v1 preserved)', () => {
  // Unknown/blank/other language → assume English input, target Hebrew.
  for (const label of ['', 'fr', 'Spanish', 'und', 'xyz']) {
    const raw = `LANG: ${label}\nVERBATIM: foo.\nTRANSLATION: bar.`;
    const out = parseFlightResponse(raw);
    assert.equal(out.translated_to, 'he', `ambiguous label "${label}" must default to he`);
  }
});

test('deriveTranslatedTo maps source language to opposite-language target', () => {
  assert.equal(deriveTranslatedTo('he'), 'en');
  assert.equal(deriveTranslatedTo('Hebrew'), 'en');
  assert.equal(deriveTranslatedTo('עברית'), 'en');
  assert.equal(deriveTranslatedTo('en'), 'he');
  assert.equal(deriveTranslatedTo('English'), 'he');
  assert.equal(deriveTranslatedTo(''), 'he');
  assert.equal(deriveTranslatedTo(undefined), 'he');
});

test('parseFlightResponse keeps multi-line verbatim + translation blocks intact', () => {
  const raw = 'LANG: English\nVERBATIM: Line one.\nLine two.\nTRANSLATION: שורה אחת.\nשורה שתיים.';
  const out = parseFlightResponse(raw);
  assert.equal(out.transcript_verbatim, 'Line one.\nLine two.');
  assert.equal(out.translation, 'שורה אחת.\nשורה שתיים.');
});

test('parseFlightResponse never drops content on parse failure (C2.1)', () => {
  // Only one unstructured block returned → surface it as verbatim, empty
  // translation signals "could not separate" to the caller (never dropped).
  const out = parseFlightResponse('Boarding is now complete.');
  assert.equal(out.transcript_verbatim, 'Boarding is now complete.');
  assert.equal(out.translation, '');
});

test('parseFlightResponse tolerates a verbatim-only structured reply', () => {
  const out = parseFlightResponse('VERBATIM: Gate change to 7.');
  assert.equal(out.transcript_verbatim, 'Gate change to 7.');
  assert.equal(out.translation, '');
});

test('parseFlightResponse on empty input returns empty fields, no throw', () => {
  const out = parseFlightResponse('');
  assert.equal(out.transcript_verbatim, '');
  assert.equal(out.translation, '');
  assert.equal(out.detected_lang, '');
  assert.equal(out.translated_to, 'he', 'empty input defaults to v1 English→Hebrew target');
});

// ── Part B — separate-function guarantee (C1.5 / STOP-list) ─────────────────────

test('flight system instruction is multilingual, NOT Hebrew-locked', () => {
  const instr = skill._internals.FLIGHT_SYSTEM_INSTRUCTION;
  assert.match(instr, /multilingual/i);
  assert.match(instr, /original spoken language/i);
  // It must NOT be the Hebrew-locked instruction from skills/voice.
  assert.doesNotMatch(instr, /Always output Hebrew text only/);
});
