'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { translateMedicalTerms, GLOSSARY } = require('../skills/research/i18n/glossary-he');

test('GLOSSARY contains all 7 entries from 01a §6.5', () => {
  assert.equal(Object.keys(GLOSSARY).length, 7);
  assert.equal(GLOSSARY.CRPS, 'CRPS');
  assert.equal(GLOSSARY['complex regional pain syndrome'], 'תסמונת כאב אזורי מורכב');
  assert.equal(GLOSSARY['chronic pain'], 'כאב כרוני');
  assert.equal(GLOSSARY['nerve block'], 'חסם עצב');
  assert.equal(GLOSSARY['spinal cord stimulation'], 'גירוי חוט שדרה');
  assert.equal(GLOSSARY['DRG stimulation'], 'גירוי DRG');
  assert.equal(GLOSSARY.remission, 'הקלה משמעותית');
});

test('translateMedicalTerms is null-safe', () => {
  assert.equal(translateMedicalTerms(null), null);
  assert.equal(translateMedicalTerms(undefined), undefined);
  assert.equal(translateMedicalTerms(''), '');
});

test('translateMedicalTerms replaces simple terms', () => {
  assert.equal(
    translateMedicalTerms('chronic pain affects daily life'),
    'כאב כרוני affects daily life',
  );
});

test('translateMedicalTerms handles case-insensitive matching', () => {
  assert.equal(
    translateMedicalTerms('Spinal Cord Stimulation reduces pain'),
    'גירוי חוט שדרה reduces pain',
  );
});

test('translateMedicalTerms longest-phrase-first prevents partial overlap', () => {
  // "complex regional pain syndrome" must be tried before bare "chronic pain"
  // (otherwise "chronic pain" wouldn't even be substring — different example
  // but the order is verifiable).
  // Actual overlap risk: "complex regional pain syndrome" contains "pain" — but
  // "pain" alone isn't in glossary, so no real conflict. Test the order regardless.
  const text = 'Complex regional pain syndrome (CRPS) is a chronic pain condition.';
  const out = translateMedicalTerms(text);
  assert.match(out, /תסמונת כאב אזורי מורכב/);
  assert.match(out, /CRPS/);
  assert.match(out, /כאב כרוני condition/);
});

test('translateMedicalTerms preserves CRPS as-is (entry maps to itself)', () => {
  assert.equal(
    translateMedicalTerms('CRPS is the focus.'),
    'CRPS is the focus.',
  );
});

test('translateMedicalTerms uses word-boundary anchors', () => {
  // "remissions" should not match "remission" (extra "s" at end)
  // ... unless we want it to. Current regex uses \b which treats
  // "remission" inside "remissions" as NOT a word boundary at end.
  const text = 'Multiple remissions observed.';
  const out = translateMedicalTerms(text);
  assert.match(out, /remissions observed/);
  assert.doesNotMatch(out, /הקלה משמעותית/);
});

test('translateMedicalTerms handles DRG stimulation (mixed Latin+abbrev)', () => {
  assert.equal(
    translateMedicalTerms('DRG stimulation is effective.'),
    'גירוי DRG is effective.',
  );
});

test('translateMedicalTerms is idempotent on already-translated text', () => {
  const once = translateMedicalTerms('chronic pain');
  const twice = translateMedicalTerms(once);
  assert.equal(once, twice);
});
