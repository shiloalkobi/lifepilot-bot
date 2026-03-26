'use strict';

/**
 * Voice Skill — transcribes Telegram voice messages via Gemini Audio API.
 * telegram.js calls transcribeVoice() directly; no agent tools are registered.
 */

const https = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const name        = 'voice';
const description = 'Transcribes Telegram voice messages using Gemini Audio API.';
const tools       = []; // intercepted at telegram.js level — no agent tools needed

// ── Download helper ───────────────────────────────────────────────────────────

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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Download a Telegram voice file and transcribe it with Gemini.
 * @param {string} fileUrl  Full Telegram file URL (includes bot token)
 * @returns {Promise<string>} Transcribed text
 */
async function transcribeVoice(fileUrl) {
  console.log('[Skills] voice: downloading audio...');
  const buffer = await downloadBuffer(fileUrl);
  const base64 = buffer.toString('base64');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-001' });

  const result = await model.generateContent([
    { text: 'Transcribe this voice message exactly. Return only the transcription, no explanations or labels.' },
    { inlineData: { mimeType: 'audio/ogg', data: base64 } },
  ]);

  return result.response.text().trim();
}

async function execute(toolName, args, ctx) {
  return `Unknown tool "${toolName}" in skill "${name}"`;
}

module.exports = { name, description, tools, execute, transcribeVoice };
