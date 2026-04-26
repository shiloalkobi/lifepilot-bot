'use strict';

const fs   = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { supabase, isEnabled } = require('./supabase');

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID
  ? Number(process.env.TELEGRAM_CHAT_ID)
  : null;

const MAX_TEXT_LENGTH = 100000; // ~25K tokens

function detectFileType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf')                     return 'pdf';
  if (ext === '.docx' || ext === '.doc')  return 'docx';
  if (ext === '.txt')                     return 'txt';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return null;
}

async function extractText(filePath, fileType) {
  if (fileType === 'pdf') {
    const { PDFParse } = require('pdf-parse');
    const buffer   = await fs.readFile(filePath);
    const parser   = new PDFParse({ data: buffer });
    const result   = await parser.getText();
    return {
      text:  (result.text || '').trim(),
      pages: result.total || (Array.isArray(result.pages) ? result.pages.length : null),
      info:  result.info || {},
    };
  }
  if (fileType === 'docx') {
    const mammoth = require('mammoth');
    const result  = await mammoth.extractRawText({ path: filePath });
    return {
      text:  (result.value || '').trim(),
      pages: null,
      info:  {},
    };
  }
  if (fileType === 'txt' || fileType === 'md') {
    const text = await fs.readFile(filePath, 'utf8');
    return { text: text.trim(), pages: null, info: {} };
  }
  throw new Error(`Unsupported file type: ${fileType}`);
}

const SUMMARY_PROMPT = (level, text) => `אתה עוזר שמסכם מסמכים בעברית.

רמת פירוט: ${level}
- short: 2-3 נקודות בלבד, סיכום קצר
- normal: 4-6 נקודות עיקריות, אזהרות אם יש, פעולות מומלצות
- detailed: 6-10 נקודות מפורטות, אזהרות, פעולות, ניתוח עומק

החזר אך ורק JSON תקין (ללא הסברים סביבו) במבנה:
{
  "summary": "תיאור של 2-3 משפטים על תוכן המסמך",
  "keyPoints": ["נקודה 1", "נקודה 2"],
  "warnings": ["אזהרה אם יש"],
  "actions": ["פעולה מומלצת אם יש"],
  "metadata": {
    "language": "hebrew" | "english" | "mixed",
    "documentType": "contract" | "proposal" | "article" | "technical" | "report" | "other",
    "topic": "תיאור קצר של הנושא"
  }
}

המסמך:
"""
${text.slice(0, MAX_TEXT_LENGTH)}
"""

JSON:`;

async function summarizeDocument(text, { level = 'normal' } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY missing');
  }
  if (!text || text.length < 50) {
    throw new Error('Text too short to summarize');
  }

  const truncated = text.length > MAX_TEXT_LENGTH;
  const wordCount = (text.match(/\S+/g) || []).length;

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const result       = await model.generateContent(SUMMARY_PROMPT(level, text));
  const responseText = (result.response.text() || '').trim();

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Invalid JSON response from Gemini');

  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) { throw new Error(`JSON parse failed: ${e.message}`); }

  return {
    summary:   parsed.summary || '',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
    warnings:  Array.isArray(parsed.warnings)  ? parsed.warnings  : [],
    actions:   Array.isArray(parsed.actions)   ? parsed.actions   : [],
    metadata: {
      ...(parsed.metadata || {}),
      wordCount,
      truncated,
      level,
    },
  };
}

async function saveSummary(chatId, data) {
  if (!isEnabled()) return null;
  const id = `sum_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { error } = await supabase.from('doc_summaries').insert({
    id,
    chat_id:       Number(chatId) || OWNER_CHAT_ID,
    filename:      data.filename || 'unnamed',
    file_type:     data.fileType,
    file_size:     data.fileSize || null,
    summary_level: data.level || 'normal',
    summary:       data.summary || '',
    key_points:    data.keyPoints || [],
    action_items:  data.actions   || [],
    warnings:      data.warnings  || [],
    metadata:      data.metadata  || {},
  });
  if (error) {
    console.warn('[DocSummary] save failed:', error.message);
    return null;
  }
  return id;
}

async function listSummaries(chatId, limit = 30) {
  if (!isEnabled()) return [];
  const { data, error } = await supabase
    .from('doc_summaries')
    .select('id, filename, file_type, file_size, summary_level, summary, metadata, created_at')
    .eq('chat_id', Number(chatId) || OWNER_CHAT_ID)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[DocSummary] list failed:', error.message);
    return [];
  }
  return data || [];
}

async function getSummary(id) {
  if (!isEnabled()) return null;
  const { data, error } = await supabase
    .from('doc_summaries')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn('[DocSummary] get failed:', error.message);
    return null;
  }
  return data;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;');
}

function formatSummaryForTelegram(s, summaryId) {
  const lines = [];
  lines.push(`📄 <b>סיכום: ${escapeHtml(s.filename || 'מסמך')}</b>`);

  const stats = [];
  if (s.metadata?.pages)        stats.push(`${s.metadata.pages} עמודים`);
  if (s.metadata?.wordCount)    stats.push(`${s.metadata.wordCount} מילים`);
  if (s.metadata?.documentType) stats.push(`סוג: ${s.metadata.documentType}`);
  if (stats.length) lines.push(`📊 ${stats.join(' · ')}`);

  lines.push('');
  lines.push(escapeHtml(s.summary));

  if (s.keyPoints && s.keyPoints.length) {
    lines.push('');
    lines.push('📌 <b>נקודות עיקריות:</b>');
    s.keyPoints.forEach(p => lines.push(`• ${escapeHtml(p)}`));
  }

  if (s.warnings && s.warnings.length) {
    lines.push('');
    lines.push('⚠️ <b>נקודות לתשומת לב:</b>');
    s.warnings.forEach(w => lines.push(`• ${escapeHtml(w)}`));
  }

  if (s.actions && s.actions.length) {
    lines.push('');
    lines.push('✅ <b>פעולות מומלצות:</b>');
    s.actions.forEach((a, i) => lines.push(`${i + 1}. ${escapeHtml(a)}`));
  }

  if (s.metadata?.truncated) {
    lines.push('');
    lines.push('ℹ️ המסמך ארוך — סוכמו 100K התווים הראשונים');
  }

  if (summaryId) {
    lines.push('');
    lines.push(`💾 ID: <code>${escapeHtml(summaryId)}</code>`);
  }

  return lines.join('\n');
}

module.exports = {
  detectFileType,
  extractText,
  summarizeDocument,
  saveSummary,
  listSummaries,
  getSummary,
  formatSummaryForTelegram,
};
