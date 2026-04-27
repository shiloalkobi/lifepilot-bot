'use strict';

const sharp = require('sharp');
const { supabase, isEnabled } = require('./supabase');

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID
  ? Number(process.env.TELEGRAM_CHAT_ID) : null;
const HF_TOKEN = process.env.HF_TOKEN;
const HF_MODEL = 'ai-forever/Real-ESRGAN';
const HF_TIMEOUT_MS = 120000;

// ─── GRID CROP ─────────────────────────────
async function cropGrid(imagePath, rows, cols) {
  if (rows < 1 || rows > 10 || cols < 1 || cols > 10) {
    throw new Error('Grid size must be between 1 and 10');
  }
  const meta = await sharp(imagePath).metadata();
  const cellW = Math.floor(meta.width / cols);
  const cellH = Math.floor(meta.height / rows);
  const pieces = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const buffer = await sharp(imagePath)
        .extract({
          left: c * cellW,
          top: r * cellH,
          width: cellW,
          height: cellH,
        })
        .png()
        .toBuffer();
      pieces.push({
        name: `piece_${r + 1}_${c + 1}.png`,
        buffer,
        dimensions: { width: cellW, height: cellH },
      });
    }
  }
  return pieces;
}

// ─── CIRCULAR CROP ─────────────────────────
async function cropCircle(imagePath, cx, cy, radius) {
  const meta = await sharp(imagePath).metadata();
  const pad = 4;

  // Bounds-safe extract origin
  const left = Math.max(0, cx - radius - pad);
  const top  = Math.max(0, cy - radius - pad);
  // Extract size: from origin to the requested far edge, clamped to image
  const right  = Math.min(meta.width,  cx + radius + pad);
  const bottom = Math.min(meta.height, cy + radius + pad);
  const width  = right  - left;
  const height = bottom - top;

  // Mask circle position is in extracted-region coordinates,
  // i.e. relative to (left, top) — NOT the geometric center of the region.
  // This stays correct even when bounds clamping makes the region asymmetric.
  const maskCx = cx - left;
  const maskCy = cy - top;

  const mask = Buffer.from(
    `<svg width="${width}" height="${height}">
       <circle cx="${maskCx}" cy="${maskCy}" r="${radius}" fill="white"/>
     </svg>`
  );

  return await sharp(imagePath)
    .extract({ left, top, width, height })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

// ─── AI UPSCALE (Hugging Face Real-ESRGAN) ─
async function upscaleAI(imageBuffer, attempt = 1) {
  if (!HF_TOKEN) {
    throw new Error('HF_TOKEN env var missing — get free token at huggingface.co/settings/tokens');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HF_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(
      `https://api-inference.huggingface.co/models/${HF_MODEL}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/octet-stream',
        },
        body: imageBuffer,
        signal: controller.signal,
      }
    );
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('AI timeout (>2 min) — try again');
    }
    throw err;
  }
  clearTimeout(timeout);

  // Model loading: retry with backoff (10s, 20s, 30s)
  if (response.status === 503 && attempt < 4) {
    const wait = attempt * 10000;
    console.log(`[ImageEditor] HF model loading, retry ${attempt}/3 in ${wait / 1000}s`);
    await new Promise(r => setTimeout(r, wait));
    return upscaleAI(imageBuffer, attempt + 1);
  }

  if (response.status === 429) {
    throw new Error('AI rate limit hit — try again in a minute');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AI upscale failed: ${response.status} ${text.slice(0, 200)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ─── AUTO-DETECT CIRCLES (Phase 1: stub) ───
async function detectCircles(_imagePath) {
  // Phase 1: not implemented. Return empty so caller can handle fallback.
  // Phase 2: implement using Sharp pixel access + connected components.
  return [];
}

// ─── STORAGE ───────────────────────────────
async function saveEdit(chatId, data) {
  if (!isEnabled()) return null;
  const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { error } = await supabase.from('image_edits').insert({
    id,
    chat_id: Number(chatId) || OWNER_CHAT_ID,
    operation: data.operation,
    source_filename: data.sourceFilename || 'unnamed',
    source_size: data.sourceSize || null,
    output_count: data.outputCount || 0,
    output_metadata: data.outputMetadata || [],
    ai_calls_used: data.aiCallsUsed || 0,
  });
  if (error) {
    console.warn('[ImageEditor] save failed:', error.message);
    return null;
  }
  return id;
}

async function listEdits(chatId, limit = 30) {
  if (!isEnabled()) return [];
  const { data, error } = await supabase
    .from('image_edits')
    .select('*')
    .eq('chat_id', Number(chatId) || OWNER_CHAT_ID)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[ImageEditor] list failed:', error.message);
    return [];
  }
  return data || [];
}

async function getEdit(id) {
  if (!isEnabled()) return null;
  const { data, error } = await supabase
    .from('image_edits')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn('[ImageEditor] get failed:', error.message);
    return null;
  }
  return data;
}

async function getMonthlyAiUsage(chatId) {
  if (!isEnabled()) return 0;
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const { data } = await supabase
    .from('image_edits')
    .select('ai_calls_used')
    .eq('chat_id', Number(chatId) || OWNER_CHAT_ID)
    .gte('created_at', startOfMonth.toISOString());
  return (data || []).reduce((sum, r) => sum + (r.ai_calls_used || 0), 0);
}

module.exports = {
  cropGrid, cropCircle, upscaleAI, detectCircles,
  saveEdit, listEdits, getEdit, getMonthlyAiUsage,
};
