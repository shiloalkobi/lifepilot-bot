'use strict';

/**
 * Vision Skill — describes Telegram photos via Gemini Vision API.
 * telegram.js calls describeImage() directly; no agent tools are registered.
 */

const https = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const name        = 'vision';
const description = 'Describes Telegram photos using Gemini Vision API.';
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
 * Download a Telegram photo and describe it with Gemini Vision.
 * @param {string} fileUrl  Full Telegram file URL (includes bot token)
 * @returns {Promise<string>} Concise image description (and any extracted text)
 */
async function describeImage(fileUrl) {
  console.log('[Skills] vision: downloading image...');
  const buffer = await downloadBuffer(fileUrl);
  const base64 = buffer.toString('base64');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model  = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const result = await model.generateContent([
    { text: 'Describe this image concisely in 1-3 sentences. If there is text in the image, extract it verbatim. Be factual and brief.' },
    { inlineData: { mimeType: 'image/jpeg', data: base64 } },
  ]);

  return result.response.text().trim();
}

/**
 * Run OCR on an image and return structured data.
 * @param {string} fileUrl  Full Telegram file URL
 * @returns {Promise<{type: string, extractedText: string, structured: object}>}
 */
async function ocrImage(fileUrl) {
  console.log('[Skills] vision: running OCR...');
  const buffer = await downloadBuffer(fileUrl);
  const base64 = buffer.toString('base64');

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model  = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const prompt = `נתח את התמונה הזו ובצע OCR.
1. זהה את סוג התמונה: מרשם/קבלה/כרטיס ביקור/טקסט/אחר
2. חלץ את כל הטקסט
3. החזר JSON בלבד (ללא מלל נוסף, ללא markdown):
{
  "type": "prescription" | "receipt" | "business_card" | "text" | "other",
  "extractedText": "כל הטקסט שחולץ מהתמונה",
  "structured": {
    // למרשם: "medications": [{"name":"...","dosage":"...","frequency":"..."}]
    // לקבלה: "amount":"...","store":"...","date":"..."
    // לכרטיס ביקור: "name":"...","phone":"...","email":"...","company":"..."
  }
}`;

  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { mimeType: 'image/jpeg', data: base64 } },
  ]);

  const raw   = result.response.text().trim();
  const clean = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(clean);
}

async function execute(toolName, args, ctx) {
  return `Unknown tool "${toolName}" in skill "${name}"`;
}

module.exports = { name, description, tools, execute, describeImage, ocrImage };
