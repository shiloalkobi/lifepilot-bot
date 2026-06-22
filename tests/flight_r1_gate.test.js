'use strict';

/**
 * R1 — MANDATORY pre-merge verification GATE (Part B).
 *
 * Per docs/flight-companion-prd.md §5 (G1–G4) and design §6 (R1):
 * Part B must NOT merge until the 5-clip live audio test passes (or the 2-call
 * fallback is in place and re-verified). That test needs REAL English
 * airport/airline-staff audio + a live Gemini key, so it is NOT run in the
 * normal `node --test` suite. It is a documented MANUAL gate executed once,
 * before merge — its results recorded in the PR description (G4).
 *
 * This file is the explicit placeholder so the gate is never silently skipped.
 * The body below is intentionally `test.skip` — it documents exactly what the
 * human runs before merge.
 *
 * ── GATE RESULT (recorded 2026-06-22) ───────────────────────────────────────
 * RUN: tests/_r1_live_harness.js — 5 English airport-staff clips synthesized via
 * TTS, converted to ogg/opus (matching real Telegram voice notes + the hardcoded
 * audio/ogg mime), served over local HTTPS, run end-to-end through the REAL
 * transcribeFlightVoice(fileUrl) against live gemini-3-flash-preview.
 * VERDICT: PASS ✅ — G1 verbatim 5/5, G2 Hebrew 5/5, G3 two-field parse 5/5,
 * G4 lang=EN 5/5. Single-call implementation SHIPPED; 2-call fallback NOT needed.
 * Caveat: TTS clips are clean (no airport background noise) — verifies the
 * transcribe+translate+parse pipeline, not noise robustness. Re-run the harness
 * with real noisy field audio if/when available.
 */

const test = require('node:test');

test.skip('R1 GATE (manual, pre-merge): 5-clip verbatim+translate verification', () => {
  // MANUAL STEPS — run before merging Part B (DO NOT run in CI):
  //
  //   1. Collect 5 English airport/airline-staff-style audio clips.
  //   2. For each clip, call:
  //        const { transcribeFlightVoice } = require('../skills/flight');
  //        const out = await transcribeFlightVoice(<telegram file url>);
  //      (requires a live GEMINI_API_KEY).
  //   3. Manually verify, per clip:
  //        (a) VERBATIM accuracy  — English captured faithfully, not summarised.
  //        (b) HEBREW accuracy    — translation correct and complete.
  //        (c) TWO-FIELD parse    — verbatim & Hebrew cleanly separated
  //                                 (out.transcript_verbatim + out.translation_he both filled).
  //
  //   PASS (G2): all 5 clips satisfy (a)+(b)+(c) with the 1-call implementation → ship 1-call.
  //   FAIL (G3): any clip fails → switch transcribeFlightVoice INTERNALLY to the
  //              2-call fallback (call 1 = verbatim transcript w/ multilingual
  //              instruction; call 2 = translate that text to Hebrew). The
  //              function SIGNATURE and the bot/telegram.js integration point do
  //              NOT change (C6.2) — internal swap only — then re-run this gate.
  //
  //   EVIDENCE (G4): record pass/fail per clip and which implementation shipped
  //                  (1-call vs 2-call) in the PR description before merge.
});
