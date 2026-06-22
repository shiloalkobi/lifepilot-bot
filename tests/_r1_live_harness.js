'use strict';
/**
 * R1 GATE — live verification harness (run manually, NOT part of node --test).
 * Generates 5 English airport-staff clips via TTS, converts to ogg/opus (to match
 * real Telegram voice notes + the hardcoded audio/ogg mime), serves them locally,
 * and runs the REAL transcribeFlightVoice(fileUrl) end-to-end against live Gemini.
 *
 * Checks: G1 verbatim accuracy, G2 Hebrew translation present+Hebrew, G3 two-field
 * parse success, G4 detected_lang = English.
 *
 * Caveat: TTS speech is clean, not real airport background noise — this verifies
 * the transcribe+translate+parse pipeline, not noise robustness.
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

const CLIPS = [
  'Sir, I need to check your boarding pass and passport, please.',
  'Your wheelchair will be tagged and returned to you at the aircraft door.',
  'We need to do a manual security screening. Please follow me to the side.',
  'Boarding for passengers who need assistance will begin first.',
  'The battery watt hour rating must be visible on the label.',
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const hasHebrew = (s) => /[֐-׿]/.test(String(s || ''));
function wordOverlap(expected, got) {
  const e = norm(expected).split(' ').filter(Boolean);
  const g = new Set(norm(got).split(' ').filter(Boolean));
  if (!e.length) return 0;
  return e.filter((w) => g.has(w)).length / e.length;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) { console.error('No GEMINI_API_KEY'); process.exit(2); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-'));
  const oggPaths = [];

  console.log('→ Generating + converting 5 clips...');
  for (let i = 0; i < CLIPS.length; i++) {
    const mp3 = await generateTTS(CLIPS[i], 'en');     // Google TTS → mp3
    const ogg = path.join(dir, `clip${i + 1}.ogg`);
    execFileSync('ffmpeg', ['-y', '-i', mp3, '-c:a', 'libopus', '-b:a', '32k', ogg], { stdio: 'ignore' });
    oggPaths.push(ogg);
  }

  // Serve the ogg files locally so the REAL transcribeFlightVoice(fileUrl) runs end-to-end.
  const tls = { key: fs.readFileSync('/tmp/r1key.pem'), cert: fs.readFileSync('/tmp/r1cert.pem') };
  const server = https.createServer(tls, (req, res) => {
    const f = path.join(dir, path.basename(req.url));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'audio/ogg' }); fs.createReadStream(f).pipe(res); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const results = [];
  for (let i = 0; i < CLIPS.length; i++) {
    const url = `https://localhost:${port}/clip${i + 1}.ogg`;
    let out, err = null;
    try { out = await flight.transcribeFlightVoice(url); } catch (e) { err = e.message; }
    results.push({ i, expected: CLIPS[i], out, err });
  }
  server.close();

  let g1 = 0, g2 = 0, g3 = 0, g4 = 0;
  for (const r of results) {
    console.log(`\n──── Clip ${r.i + 1} ────`);
    console.log('  expected :', r.expected);
    if (r.err) { console.log('  ERROR    :', r.err); continue; }
    const ov = wordOverlap(r.expected, r.out.transcript_verbatim);
    const G1 = ov >= 0.7;
    const G2 = !!r.out.translation_he && hasHebrew(r.out.translation_he);
    const G3 = !!r.out.transcript_verbatim && !!r.out.translation_he;
    const G4 = /en|eng|english/i.test(r.out.detected_lang || '');
    console.log('  verbatim :', r.out.transcript_verbatim);
    console.log('  hebrew   :', r.out.translation_he);
    console.log('  lang     :', r.out.detected_lang);
    console.log(`  G1 verbatim≥0.7 (${ov.toFixed(2)}): ${G1 ? '✓' : '✗'}  G2 hebrew: ${G2 ? '✓' : '✗'}  G3 2-field: ${G3 ? '✓' : '✗'}  G4 lang=EN: ${G4 ? '✓' : '✗'}`);
    if (G1) g1++; if (G2) g2++; if (G3) g3++; if (G4) g4++;
  }

  console.log(`\n════ R1 SUMMARY (n=${CLIPS.length}) ════`);
  console.log(`  G1 verbatim accuracy : ${g1}/${CLIPS.length}`);
  console.log(`  G2 hebrew translation: ${g2}/${CLIPS.length}`);
  console.log(`  G3 two-field parse   : ${g3}/${CLIPS.length}`);
  console.log(`  G4 lang detect = EN  : ${g4}/${CLIPS.length}`);
  const pass = g1 === CLIPS.length && g2 === CLIPS.length && g3 === CLIPS.length;
  console.log(`  VERDICT: ${pass ? 'PASS ✅ (single-call works)' : 'FAIL ❌ → consider 2-call fallback'}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(3); });
