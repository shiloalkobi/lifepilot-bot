'use strict';
/**
 * R4 GATE — live TTS + Telegram sendVoice verification (run manually, NOT in CI).
 *
 * Flight Companion v2 sends a VOICE note (the English translation) when Hebrew
 * was spoken. This gate verifies that end-to-end against the REAL Telegram bot:
 *
 *   (i)  generateTTS(<English sentence>, 'en') — report ElevenLabs vs Google
 *        (by output file size heuristic + the [TTS] fallback log) and file size.
 *   (ii) bot.sendVoice(ownerChat, fs.createReadStream(mp3Path)) with RAW MP3,
 *        copying bot/agent.js:888 verbatim. Report success or the thrown error.
 *        If raw MP3 throws → convert mp3→ogg (ffmpeg libopus) and retry; report
 *        which format Telegram accepted.
 *
 * This sends a REAL voice note to the owner chat for a human ear-check. Intended:
 * it IS the live gate. Each format is attempted at most once (no loop).
 *
 * Owner chat: TELEGRAM_CHAT_ID (the gate the bot uses), falling back to
 * ALERT_CHAT_ID — mirrors the scheduler's owner-resolution.
 */
require('dotenv').config();
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { generateTTS } = require('../bot/tts');

const SENTENCE = 'Sir, please proceed to gate twelve. Your wheelchair will be returned at the aircraft door.';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.ALERT_CHAT_ID;
  if (!token)  { console.error('No TELEGRAM_BOT_TOKEN'); process.exit(2); }
  if (!chatId) { console.error('No TELEGRAM_CHAT_ID / ALERT_CHAT_ID'); process.exit(2); }

  const usingEleven = !!process.env.ELEVENLABS_API_KEY;
  console.log(`→ ELEVENLABS_API_KEY set: ${usingEleven ? 'yes (ElevenLabs primary)' : 'no (Google fallback)'}`);

  // (i) TTS
  console.log('\n── (i) generateTTS(en) ──');
  const mp3Path = await generateTTS(SENTENCE, 'en');
  const size = fs.statSync(mp3Path).size;
  console.log('  mp3 path :', mp3Path);
  console.log('  mp3 size :', size, 'bytes');
  // ElevenLabs eleven_multilingual_v2 produces noticeably larger files than the
  // Google translate_tts fallback for the same sentence; report both the flag
  // and the size so the human can confirm which engine actually answered.
  console.log('  engine   :', usingEleven ? 'ElevenLabs (unless [TTS] fallback log above)' : 'Google translate_tts');

  const bot = new TelegramBot(token);

  // (ii) sendVoice RAW MP3 — copy of bot/agent.js:888
  console.log('\n── (ii) bot.sendVoice RAW MP3 ──');
  let rawOk = false;
  try {
    await bot.sendVoice(chatId, fs.createReadStream(mp3Path));
    rawOk = true;
    console.log('  RAW MP3 sendVoice: SUCCESS ✅ (voice note delivered to owner)');
  } catch (e) {
    console.log('  RAW MP3 sendVoice: THREW ❌ —', e.message);
  }

  let oggOk = null;
  if (!rawOk) {
    console.log('\n── (ii-b) fallback: convert mp3→ogg (libopus) and retry ──');
    const oggPath = path.join(path.dirname(mp3Path), `r4-${Date.now()}.ogg`);
    try {
      execFileSync('ffmpeg', ['-y', '-i', mp3Path, '-c:a', 'libopus', '-b:a', '32k', oggPath], { stdio: 'ignore' });
      await bot.sendVoice(chatId, fs.createReadStream(oggPath));
      oggOk = true;
      console.log('  OGG sendVoice: SUCCESS ✅ (voice note delivered to owner)');
    } catch (e) {
      oggOk = false;
      console.log('  OGG sendVoice: THREW ❌ —', e.message);
    }
  }

  console.log('\n════ R4 SUMMARY ════');
  console.log(`  TTS engine     : ${usingEleven ? 'ElevenLabs (primary)' : 'Google (fallback)'}  | file ${size} bytes`);
  if (rawOk) {
    console.log('  VERDICT        : RAW MP3 ACCEPTED ✅ — v2 does NOT need ffmpeg; ship raw mp3 stream.');
  } else if (oggOk) {
    console.log('  VERDICT        : RAW MP3 REJECTED, OGG ACCEPTED — v2 NEEDS ffmpeg mp3→ogg conversion.');
  } else {
    console.log('  VERDICT        : BOTH FORMATS FAILED ❌ — investigate token/chat/network.');
  }
  process.exit(rawOk || oggOk ? 0 : 1);
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(3); });
