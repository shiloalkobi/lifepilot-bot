'use strict';

const fs   = require('fs');
const path = require('path');

const WORDS_FILE    = path.join(__dirname, '..', 'data', 'english-words.json');
const PROGRESS_FILE = path.join(__dirname, '..', 'data', 'english-progress.json');

// ── Data ──────────────────────────────────────────────────────────────────────
function loadWords() {
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

// Consistent daily word selection — same word all day, rotates daily
function getDailyWord() {
  const words    = loadWords();
  const progress = loadProgress();
  const today    = todayIL();

  // Return cached daily word if already set for today
  if (progress.dailyWords[today]) {
    return words.find((w) => w.word === progress.dailyWords[today]) || pickWord(words, progress);
  }

  const word = pickWord(words, progress);
  progress.dailyWords[today] = word.word;

  // Mark practice date
  if (!progress.dates.includes(today)) progress.dates.push(today);
  progress.lastPracticed = today;

  // Keep dailyWords dict lean (last 60 days)
  const keys = Object.keys(progress.dailyWords).sort();
  if (keys.length > 60) delete progress.dailyWords[keys[0]];

  saveProgress(progress);
  return word;
}

function pickWord(words, progress) {
  // Difficulty based on quiz success rate
  const difficulty = getUserDifficulty(progress);
  const pool = words.filter((w) => w.difficulty === difficulty && !progress.wordsLearned.includes(w.word));
  // If pool empty, use all words of that difficulty
  const source = pool.length > 0 ? pool : words.filter((w) => w.difficulty === difficulty);
  // Use day-of-year as seed for consistency within the day
  const doy = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return source[doy % source.length];
}

function getUserDifficulty(progress) {
  if (progress.quizScores.length < 5) return 'beginner';
  const recent = progress.quizScores.slice(-10);
  const rate   = recent.reduce((s, q) => s + q.correct / q.total, 0) / recent.length;
  if (rate >= 0.8) return 'advanced';
  if (rate >= 0.6) return 'intermediate';
  return 'beginner';
}

function getRandomWord() {
  const words = loadWords();
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

  // Streak only counts if practiced today or yesterday
  if (sorted[0] !== today && sorted[0] !== yStr) return 0;

  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T12:00:00');
    const curr = new Date(sorted[i] + 'T12:00:00');
    const diff = Math.round((prev - curr) / 86400000);
    if (diff === 1) streak++;
    else break;
  }
  return streak;
}

// ── Formatting ────────────────────────────────────────────────────────────────
const POS_ICONS = { verb: '🔧', noun: '📦', adjective: '🎨', 'adj/verb': '🎨🔧', 'verb/noun': '🔧📦', 'noun/adj': '📦🎨', 'adjective/noun': '🎨📦' };

function formatWord(w, label = '📚 מילת היום') {
  const pos  = POS_ICONS[w.partOfSpeech] || '📝';
  const diff = { beginner: '🟢 מתחיל', intermediate: '🟡 בינוני', advanced: '🔴 מתקדם' }[w.difficulty] || '';
  return (
    `${label}\n\n` +
    `📖 <b>${w.word}</b>\n` +
    `🇮🇱 <b>${w.translation}</b>\n` +
    `${pos} ${w.partOfSpeech} | ${diff}\n\n` +
    `💬 <i>"${w.example}"</i>\n\n` +
    `🔥 Streak: ${getStreak()} ימים | /english quiz לקווiz`
  );
}

// ── Quiz ──────────────────────────────────────────────────────────────────────
// Map<chatId, { word, correctIdx, options }>
const quizSessions = new Map();

function startQuiz(chatId) {
  const words  = loadWords();
  const word   = getDailyWord();
  const wrongs = words
    .filter((w) => w.word !== word.word)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3)
    .map((w) => w.translation);

  const correctIdx = Math.floor(Math.random() * 4);
  const options    = [...wrongs];
  options.splice(correctIdx, 0, word.translation);

  quizSessions.set(chatId, { word, correctIdx, options });

  const optLines = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  return (
    `🎯 <b>קווiz — מה המשמעות של:</b>\n\n` +
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

  // Save quiz score
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
  // Keep quizScores last 90 days
  if (progress.quizScores.length > 90) progress.quizScores.shift();
  saveProgress(progress);

  const { word } = session;
  if (correct) {
    return {
      reply:
        `✅ <b>נכון!</b> 🎉\n\n` +
        `📖 <b>${word.word}</b> = ${word.translation}\n` +
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

  const fire = streak >= 7 ? '🔥🔥🔥' : streak >= 3 ? '🔥🔥' : streak >= 1 ? '🔥' : '💤';

  return (
    `${fire} <b>English Streak</b>\n\n` +
    `🔥 רצף: <b>${streak} ימים</b>\n` +
    `📚 מילים שנלמדו: <b>${total}</b>\n` +
    `✅ דיוק (10 אחרונים): <b>${rate}%</b>\n` +
    `📊 רמה נוכחית: ${lvlLabel}`
  );
}

module.exports = {
  getDailyWord,
  getRandomWord,
  formatWord,
  startQuiz,
  isInQuiz,
  processQuizAnswer,
  formatStreak,
};
