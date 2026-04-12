'use strict';

/**
 * tts.js — Text-to-Speech using Google Translate TTS (free, no key needed).
 * Limit: 200 chars per request.
 * Returns a path to an MP3 temp file.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const MAX_CHARS = 200;

function generateTTS(text, lang = 'iw') {
  // Truncate to Google TTS limit
  const safe = String(text).slice(0, MAX_CHARS);
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
          return reject(new Error(`TTS HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(out);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(out); });
        file.on('error', reject);
      }).on('error', reject)
        .setTimeout(10000, function() { this.destroy(); reject(new Error('TTS timeout')); });
    };
    follow(url);
  });
}

module.exports = { generateTTS };
