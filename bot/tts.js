'use strict';

/**
 * tts.js — Text-to-Speech.
 * Primary: ElevenLabs API (requires ELEVENLABS_API_KEY env var).
 * Fallback: Google Translate TTS (free, no key needed, 200 char limit).
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID           = 'pNInz6obpgDQGcFmaJgB'; // Adam — good Hebrew
const MAX_CHARS_GOOGLE   = 200;

// ── Google TTS fallback ───────────────────────────────────────────────────────

function generateGoogleTTS(text, lang = 'iw') {
  const safe = String(text).slice(0, MAX_CHARS_GOOGLE);
  const q    = encodeURIComponent(safe);
  const url  = `https://translate.google.com/translate_tts?ie=UTF-8&q=${q}&tl=${lang}&client=tw-ob`;
  const out  = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`);

  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer':    'https://translate.google.com/',
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Google TTS HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(out);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(out); });
        file.on('error', reject);
      }).on('error', reject)
        .setTimeout(10000, function () { this.destroy(); reject(new Error('Google TTS timeout')); });
    };
    follow(url);
  });
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────

function generateElevenLabsTTS(text) {
  const body    = JSON.stringify({
    text:          String(text).slice(0, 500),
    model_id:      'eleven_multilingual_v2',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });
  const outPath = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path:     `/v1/text-to-speech/${VOICE_ID}`,
      method:   'POST',
      headers:  {
        'xi-api-key':     ELEVENLABS_API_KEY,
        'Content-Type':   'application/json',
        'Accept':         'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => reject(new Error(`ElevenLabs error: ${res.statusCode} — ${errBody.slice(0, 200)}`)));
        return;
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(outPath); });
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { this.destroy(); reject(new Error('ElevenLabs timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function generateTTS(text, lang = 'iw') {
  if (ELEVENLABS_API_KEY) {
    try {
      return await generateElevenLabsTTS(text);
    } catch (e) {
      console.warn('[TTS] ElevenLabs failed, falling back to Google:', e.message);
    }
  }
  return generateGoogleTTS(text, lang);
}

module.exports = { generateTTS };
