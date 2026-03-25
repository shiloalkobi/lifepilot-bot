'use strict';

const fs   = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const WORDS_FILE    = path.join(__dirname, '..', 'data', 'english-words.json');
const PROGRESS_FILE = path.join(__dirname, '..', 'data', 'english-progress.json');

// ── Gemini client (reuse env key already configured for chat) ─────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Data ──────────────────────────────────────────────────────────────────────
function loadStaticWords() {
  try { return JSON.parse(fs.readFileSync(WORDS_FILE, 'utf8')); } catch { return []; }
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch {
    return { dates: [], wordsLearned: [], quizScores: [], lastPracticed: null, dailyWords: {} };
  }
}

function saveProgress(p) {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2), 'utf8');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayIL() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function getUserDifficulty(progress) {
  if (progress.quizScores.length < 5) return 'beginner';
  const recent = progress.quizScores.slice(-10);
  const rate   = recent.reduce((s, q) => s + q.correct / q.total, 0) / recent.length;
  if (rate >= 0.8) return 'advanced';
  if (rate >= 0.6) return 'intermediate';
  return 'beginner';
}

// ── AI word generation ────────────────────────────────────────────────────────
async function generateWordFromAI(difficulty, excludeWords) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-001' });

  const excluded = excludeWords.slice(-50).join(', ') || 'none';

  const prompt = `Generate a single English vocabulary word for a Hebrew-speaking developer learning English.

Requirements:
- Difficulty level: ${difficulty}
- The word must NOT be any of these already-learned words: ${excluded}
- Practical and useful for daily life, technology, or professional work
- Not too obscure or overly academic

Return ONLY a valid JSON object (no markdown, no backticks) with exactly these fields:
{
  "word": "the English word",
  "translation": "Hebrew translation (concise, 1-4 words)",
  "partOfSpeech": "noun/verb/adjective/adverb",
  "example": "A clear, practical English sentence using the word.",
  "difficulty": "${difficulty}",
  "pronunciation": "phonetic hint, e.g. /rɪˈzɪl.jəns/ or (ri-ZIL-yens)",
  "commonMistake": "One common mistake Hebrew speakers make with this word (in Hebrew)",
  "relatedWords": ["related1", "related2", "related3"]
}`;

  const result = await model.generateContent(prompt);
  const raw    = result.response.text().trim();

  // Strip markdown code fences if Gemini adds them
  const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  const word    = JSON.parse(cleaned);

  // Validate required fields
  const required = ['word', 'translation', 'partOfSpeech', 'example', 'difficulty'];
  for (const f of required) {
    if (!word[f]) throw new Error(`Missing field: ${f}`);
  }
  return word;
}

// Fallback: pick from static bank
function pickStaticWord(difficulty, excludeWords) {
  const words  = loadStaticWords();
  const pool   = words.filter((w) => w.difficulty === difficulty && !excludeWords.includes(w.word));
  const source = pool.length > 0 ? pool : words.filter((w) => w.difficulty === difficulty);
  if (!source.length) return words[0];
  const doy = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return source[doy % source.length];
}

// ── AI quiz options ───────────────────────────────────────────────────────────
async function generateQuizOptions(word) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-001' });

  const prompt = `The English word "${word.word}" means "${word.translation}" in Hebrew.
Generate 3 plausible but WRONG Hebrew translations that could trick a learner.
They should be real Hebrew words, similar in theme but incorrect.
Return ONLY a JSON array of 3 strings, no markdown, e.g.: ["תשובה1", "תשובה2", "תשובה3"]`;

  const result  = await model.generateContent(prompt);
  const raw     = result.response.text().trim();
  const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  const options = JSON.parse(cleaned);
  if (!Array.isArray(options) || options.length < 3) throw new Error('Invalid quiz options');
  return options.slice(0, 3);
}

// ── Main: get daily word (AI-first, static fallback) ─────────────────────────
async function getDailyWord() {
  const progress = loadProgress();
  const today    = todayIL();

  // Return cached word for today
  if (progress.dailyWordData?.[today]) {
    return progress.dailyWordData[today];
  }

  const difficulty = getUserDifficulty(progress);
  let word;

  try {
    word = await generateWordFromAI(difficulty, progress.wordsLearned);
    console.log(`[English] AI generated: "${word.word}" (${difficulty})`);
  } catch (err) {
    console.warn(`[English] AI failed (${err.message}), using static fallback`);
    word = pickStaticWord(difficulty, progress.wordsLearned);
  }

  // Cache today's word
  if (!progress.dailyWordData) progress.dailyWordData = {};
  progress.dailyWordData[today] = word;

  // Keep cache lean (last 60 days)
  const keys = Object.keys(progress.dailyWordData).sort();
  if (keys.length > 60) delete progress.dailyWordData[keys[0]];

  // Track practice date
  if (!progress.dates.includes(today)) progress.dates.push(today);
  progress.lastPracticed = today;

  saveProgress(progress);
  return word;
}

// Sync version for fallback contexts (returns cached or static)
function getDailyWordSync() {
  const progress = loadProgress();
  const today    = todayIL();
  if (progress.dailyWordData?.[today]) return progress.dailyWordData[today];
  return pickStaticWord(getUserDifficulty(progress), progress.wordsLearned);
}

function getRandomWord() {
  const words = loadStaticWords();
  return words[Math.floor(Math.random() * words.length)];
}

// ── Streak ────────────────────────────────────────────────────────────────────
function getStreak() {
  const { dates } = loadProgress();
  if (!dates.length) return 0;

  const sorted = [...dates].sort().reverse();
  const today  = todayIL();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

  if (sorted[0] !== today && sorted[0] !== yStr) return 0;

  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T12:00:00');
    const curr = new Date(sorted[i] + 'T12:00:00');
    if (Math.round((prev - curr) / 86400000) === 1) streak++;
    else break;
  }
  return streak;
}

// ── Formatting ────────────────────────────────────────────────────────────────
const POS_ICONS = {
  verb: '🔧', noun: '📦', adjective: '🎨', adverb: '💨',
  'adj/verb': '🎨🔧', 'verb/noun': '🔧📦', 'noun/adj': '📦🎨', 'adjective/noun': '🎨📦',
};

function formatWord(w, label = '📚 מילת היום') {
  const pos  = POS_ICONS[w.partOfSpeech] || '📝';
  const diff = { beginner: '🟢 מתחיל', intermediate: '🟡 בינוני', advanced: '🔴 מתקדם' }[w.difficulty] || '';

  let msg =
    `${label}\n\n` +
    `📖 <b>${w.word}</b>\n` +
    `🇮🇱 <b>${w.translation}</b>\n` +
    `${pos} ${w.partOfSpeech} | ${diff}\n`;

  if (w.pronunciation) msg += `🔊 <i>${w.pronunciation}</i>\n`;

  msg += `\n💬 <i>"${w.example}"</i>\n`;

  if (w.commonMistake) msg += `\n⚠️ <b>טעות נפוצה:</b> ${w.commonMistake}\n`;

  if (w.relatedWords?.length) {
    msg += `\n🔗 <b>מילים קשורות:</b> ${w.relatedWords.join(' • ')}\n`;
  }

  msg += `\n🔥 Streak: ${getStreak()} ימים | /english quiz לקוויז`;
  return msg;
}

// ── Quiz ──────────────────────────────────────────────────────────────────────
const quizSessions = new Map();

async function startQuiz(chatId) {
  const word = getDailyWordSync();
  let wrongs;

  try {
    wrongs = await generateQuizOptions(word);
  } catch {
    // Fallback: random translations from static bank
    const staticWords = loadStaticWords();
    wrongs = staticWords
      .filter((w) => w.word !== word.word)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .map((w) => w.translation);
  }

  const correctIdx = Math.floor(Math.random() * 4);
  const options    = [...wrongs];
  options.splice(correctIdx, 0, word.translation);

  quizSessions.set(chatId, { word, correctIdx, options });

  const optLines = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  return (
    `🎯 <b>קוויז — מה המשמעות של:</b>\n\n` +
    `📖 <b>${word.word}</b>\n\n` +
    `${optLines}\n\n` +
    `ענה עם מספר (1-4)`
  );
}

function isInQuiz(chatId) {
  return quizSessions.has(chatId);
}

function processQuizAnswer(chatId, text) {
  const session = quizSessions.get(chatId);
  if (!session) return null;

  const n = parseInt(text.trim());
  if (isNaN(n) || n < 1 || n > 4) {
    return { reply: '⚠️ ענה עם מספר בין 1 ל-4.', done: false };
  }

  quizSessions.delete(chatId);
  const correct = n - 1 === session.correctIdx;

  const progress = loadProgress();
  const today    = todayIL();
  let dayScore   = progress.quizScores.find((q) => q.date === today);
  if (!dayScore) {
    dayScore = { date: today, correct: 0, total: 0 };
    progress.quizScores.push(dayScore);
  }
  dayScore.total++;
  if (correct) {
    dayScore.correct++;
    if (!progress.wordsLearned.includes(session.word.word)) {
      progress.wordsLearned.push(session.word.word);
    }
  }
  if (progress.quizScores.length > 90) progress.quizScores.shift();
  saveProgress(progress);

  const { word } = session;
  if (correct) {
    return {
      reply:
        `✅ <b>נכון!</b> 🎉\n\n` +
        `📖 <b>${word.word}</b> = ${word.translation}\n` +
        (word.pronunciation ? `🔊 <i>${word.pronunciation}</i>\n` : '') +
        `💬 <i>"${word.example}"</i>\n\n` +
        `🔥 Streak: ${getStreak()} ימים`,
      done: true, correct: true,
    };
  } else {
    return {
      reply:
        `❌ <b>לא נכון.</b>\n\n` +
        `✅ התשובה הנכונה: <b>${word.translation}</b>\n` +
        `📖 ${word.word} — ${word.partOfSpeech}\n` +
        (word.pronunciation ? `🔊 <i>${word.pronunciation}</i>\n` : '') +
        `💬 <i>"${word.example}"</i>`,
      done: true, correct: false,
    };
  }
}

function formatStreak() {
  const streak   = getStreak();
  const progress = loadProgress();
  const total    = progress.wordsLearned.length;
  const scores   = progress.quizScores.slice(-10);
  const rate     = scores.length
    ? Math.round(scores.reduce((s, q) => s + q.correct / q.total, 0) / scores.length * 100)
    : 0;
  const level    = getUserDifficulty(progress);
  const lvlLabel = { beginner: '🟢 מתחיל', intermediate: '🟡 בינוני', advanced: '🔴 מתקדם' }[level];
  const fire     = streak >= 7 ? '🔥🔥🔥' : streak >= 3 ? '🔥🔥' : streak >= 1 ? '🔥' : '💤';

  return (
    `${fire} <b>English Streak</b>\n\n` +
    `🔥 רצף: <b>${streak} ימים</b>\n` +
    `📚 מילים שנלמדו: <b>${total}</b>\n` +
    `✅ דיוק (10 אחרונים): <b>${rate}%</b>\n` +
    `📊 רמה נוכחית: ${lvlLabel}\n\n` +
    `<i>מילות היום מיוצרות ע"י Gemini AI ✨</i>`
  );
}

module.exports = {
  getDailyWord,
  getDailyWordSync,
  getRandomWord,
  formatWord,
  startQuiz,
  isInQuiz,
  processQuizAnswer,
  formatStreak,
};
