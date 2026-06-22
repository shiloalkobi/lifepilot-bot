'use strict';
/**
 * R3 GATE — live BIDIRECTIONAL direction verification (run manually, NOT in CI).
 *
 * Extends the R1 harness approach to TWO clips that exercise both directions of
 * Flight Companion v2:
 *   (a) Hebrew clip  (generateTTS(hebrewText, 'iw')) → expect detected Hebrew,
 *       translation in English, translated_to === 'en'.
 *   (b) English clip (generateTTS(englishText, 'en')) → expect detected English,
 *       translation in Hebrew, translated_to === 'he'.
 *
 * Pipeline mirrors tests/_r1_live_harness.js: TTS mp3 → ffmpeg ogg/opus (matches
 * real Telegram voice notes + the hardcoded audio/ogg mime) → local HTTPS
 * (self-signed) → REAL transcribeFlightVoice(fileUrl) against live Gemini.
 *
 * If direction is WRONG for either clip → FLAG the 2-call fallback; do not ship.
 *
 * Caveat: TTS speech is clean (no airport background noise) — verifies the
 * detect+transcribe+translate+direction pipeline, not noise robustness.
 */
require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // accept self-signed local test cert
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { generateTTS } = require('../bot/tts');
const flight = require('../skills/flight');

const hasHebrew  = (s) => /[֐-׿]/.test(String(s || ''));
const hasLatin   = (s) => /[a-z]/i.test(String(s || ''));

const CLIPS = [
  {
    id: 'hebrew',
    text: 'אנא לך לשער שתים עשרה. הטיסה שלך מתעכבת בחצי שעה.',
    lang: 'iw',
    expectDetect: /he|heb|hebrew|iw|עברית/i,
    expectTranslatedTo: 'en',
    translationIsLatin: true,  // translation should be English
  },
  {
    id: 'english',
    text: 'Sir, your wheelchair will be tagged and returned at the aircraft door.',
    lang: 'en',
    expectDetect: /en|eng|english/i,
    expectTranslatedTo: 'he',
    translationIsLatin: false, // translation should be Hebrew
  },
];

function ensureCert() {
  const key = '/tmp/r3key.pem';
  const cert = '/tmp/r3cert.pem';
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.log('→ Generating self-signed cert for local HTTPS...');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
  }
  return { key, cert };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) { console.error('No GEMINI_API_KEY'); process.exit(2); }
  const { key, cert } = ensureCert();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-'));

  console.log('→ Generating + converting 2 clips (HE + EN)...');
  for (const clip of CLIPS) {
    const mp3 = await generateTTS(clip.text, clip.lang);
    const ogg = path.join(dir, `${clip.id}.ogg`);
    execFileSync('ffmpeg', ['-y', '-i', mp3, '-c:a', 'libopus', '-b:a', '32k', ogg], { stdio: 'ignore' });
    clip.ogg = ogg;
  }

  const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const server = https.createServer(tls, (req, res) => {
    const f = path.join(dir, path.basename(req.url));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'audio/ogg' }); fs.createReadStream(f).pipe(res); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  let allPass = true;
  for (const clip of CLIPS) {
    const url = `https://localhost:${port}/${clip.id}.ogg`;
    let out, err = null;
    try { out = await flight.transcribeFlightVoice(url); } catch (e) { err = e.message; }

    console.log(`\n──── Clip ${clip.id.toUpperCase()} ────`);
    console.log('  spoken    :', clip.text);
    if (err) { console.log('  ERROR     :', err); allPass = false; continue; }
    console.log('  verbatim  :', out.transcript_verbatim);
    console.log('  translation:', out.translation);
    console.log('  detected  :', out.detected_lang);
    console.log('  translated_to:', out.translated_to);

    const cDetect = clip.expectDetect.test(out.detected_lang || '');
    const cTo     = out.translated_to === clip.expectTranslatedTo;
    const transOk = clip.translationIsLatin
      ? (hasLatin(out.translation) && !hasHebrew(out.translation))
      : (hasHebrew(out.translation));
    const cParse  = !!out.transcript_verbatim && !!out.translation;

    console.log(`  detect=${clip.expectDetect}: ${cDetect ? '✓' : '✗'}` +
                `  translated_to=${clip.expectTranslatedTo}: ${cTo ? '✓' : '✗'}` +
                `  translation lang ok: ${transOk ? '✓' : '✗'}` +
                `  two-field parse: ${cParse ? '✓' : '✗'}`);
    const clipPass = cDetect && cTo && transOk && cParse;
    console.log(`  → ${clipPass ? 'PASS ✅' : 'FAIL ❌'}`);
    if (!clipPass) allPass = false;
  }
  server.close();

  console.log(`\n════ R3 SUMMARY (bidirectional) ════`);
  console.log(`  VERDICT: ${allPass
    ? 'PASS ✅ — both directions correct, single-call SHIPS'
    : 'FAIL ❌ — direction wrong → switch to 2-call fallback, DO NOT ship'}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(3); });
