'use strict';

const https  = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { canCall, increment } = require('./rate-limiter');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'LifePilot-Bot/1.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Hacker News fetch ─────────────────────────────────────────────────────────

async function fetchTopStories(count = 10) {
  const idsJson = await httpGet('https://hacker-news.firebaseio.com/v0/topstories.json');
  const ids     = JSON.parse(idsJson).slice(0, 30); // grab top 30 to filter by score

  // Fetch stories in parallel (batches of 10 to avoid flooding)
  const stories = await Promise.all(
    ids.map((id) =>
      httpGet(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
        .then((json) => JSON.parse(json))
        .catch(() => null)
    )
  );

  return stories
    .filter((s) => s && s.title && s.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

function domain(url) {
  if (!url) return 'news.ycombinator.com';
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return ''; }
}

function storyLink(story) {
  const url = story.url || `https://news.ycombinator.com/item?id=${story.id}`;
  return `<a href="${url}">${story.title}</a>`;
}

// ── AI summary ────────────────────────────────────────────────────────────────

async function generateAiSummary(stories) {
  if (!canCall()) return null;
  increment();

  const headlines = stories.slice(0, 5).map((s, i) => `${i + 1}. ${s.title}`).join('\n');

  try {
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-001' });
    const result = await model.generateContent(
      `אלו כותרות הטכנולוגיה המובילות ב-Hacker News היום:\n${headlines}\n\n` +
      `כתוב סיכום קצר של 2-3 משפטים בעברית על הטרנדים הבולטים. ` +
      `ישיר, טכני, רלוונטי למפתח ישראלי. ללא כותרת.`
    );
    return result.response.text().trim();
  } catch (err) {
    console.error('[News] AI summary error:', err.message);
    return null;
  }
}

// ── Format messages ───────────────────────────────────────────────────────────

function todayHebrew() {
  return new Date().toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long', year: 'numeric',
  });
}

async function buildNewsMessage(full = false) {
  const count   = full ? 10 : 5;
  const stories = await fetchTopStories(count);

  if (stories.length === 0) throw new Error('no stories');

  const lines = [`📰 <b>חדשות טכנולוגיה — ${todayHebrew()}</b>\n`];

  stories.forEach((s, i) => {
    const dm = domain(s.url);
    lines.push(`${i + 1}. 🔗 ${storyLink(s)} <i>(${s.score})</i>${dm ? ` — ${dm}` : ''}`);
  });

  if (!full) {
    const summary = await generateAiSummary(stories);
    if (summary) {
      lines.push(`\n💡 <b>סיכום AI:</b> ${summary}`);
    }
    lines.push(`\n<i>/news full — 10 כתבות עם קישורים</i>`);
  }

  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

async function sendNews(bot, chatId, full = false) {
  try {
    const msg = await buildNewsMessage(full);
    await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
    console.log(`[News] Sent (full=${full}) to ${chatId}`);
  } catch (err) {
    console.error('[News] Error:', err.message);
    bot.sendMessage(chatId, '📰 חדשות לא זמינות כרגע. נסה שוב מאוחר יותר.').catch(() => {});
  }
}

module.exports = { sendNews };
