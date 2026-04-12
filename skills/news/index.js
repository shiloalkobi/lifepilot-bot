'use strict';

/**
 * news skill — 6-category personalized news system for Shilo.
 * Feels like a personal newspaper. Hebrew summary per article.
 *
 * Categories: ai | saas | market | israel | crps | crypto | all
 * Anti-duplication: data/news-seen.json (7-day window)
 */

const { fetchAIDev, fetchSaaS, fetchMarkets, fetchIsraelTech, fetchCRPS, fetchCrypto } = require('./fetchers');
const { filterAndMark } = require('./seen');

const name        = 'news';
const description = 'Personal 6-category newspaper: AI, SaaS, Markets, Israeli Tech, CRPS, Crypto.';

const tools = [
  {
    name:        'get_news',
    description: 'הבא חדשות: ai/saas/market/israel/crps/crypto/all.',
    parameters: {
      type:       'object',
      properties: {
        category: {
          type: 'string',
          enum: ['ai', 'saas', 'market', 'israel', 'crps', 'crypto', 'all'],
          description: 'ברירת מחדל: all',
        },
      },
      required: [],
    },
  },
];

// ── Metadata per category ─────────────────────────────────────────────────────

const META = {
  ai:     { emoji: '🤖', title: 'AI & כלי פיתוח',      fetcher: fetchAIDev,     max: 3 },
  saas:   { emoji: '🚀', title: 'SaaS & עסקים',         fetcher: fetchSaaS,      max: 2 },
  market: { emoji: '📈', title: 'שוק ההון',              fetcher: fetchMarkets,   max: 3 },
  israel: { emoji: '🇮🇱', title: 'סטארטאפים ישראלים',  fetcher: fetchIsraelTech, max: 2 },
  crps:   { emoji: '💊', title: 'CRPS & כאב כרוני',     fetcher: fetchCRPS,      max: 1 },
  crypto: { emoji: '🌐', title: 'Web3 & קריפטו',        fetcher: fetchCrypto,    max: 2 },
};

// ── Date header ───────────────────────────────────────────────────────────────

function dateHeader() {
  return new Date().toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday:  'long',
    day:      'numeric',
    month:    'numeric',
  });
}

// ── Format a single category block ───────────────────────────────────────────

function formatBlock(catKey, items) {
  if (!items || !items.length) return null;
  const { emoji, title } = META[catKey];
  const lines = [`${emoji} <b>${title}:</b>`];
  for (const art of items) {
    const summaryPart = art.summary ? ` — ${art.summary}` : '';
    const srcPart     = art.source  ? ` [${art.source}]`  : '';
    lines.push(`• <a href="${art.url}">${art.title}</a>${summaryPart}${srcPart}`);
  }
  return lines.join('\n');
}

// ── Fetch one category ────────────────────────────────────────────────────────

async function fetchCategory(catKey, ignoreDedup = false) {
  const { fetcher, max } = META[catKey];
  let raw = [];
  try { raw = await fetcher(max + 2); } catch (e) { console.warn(`[News] ${catKey}:`, e.message); }
  return filterAndMark(raw, ignoreDedup).slice(0, max);
}

// ── Build full news message ───────────────────────────────────────────────────
//
// opts.ignoreDedup = false (default, scheduler) → dedup applied, marks seen
// opts.ignoreDedup = true  (manual/agent)       → always fresh, no dedup filter

async function buildNewsMessage(category = 'all', opts = {}) {
  const ignoreDedup = opts.ignoreDedup !== false; // default TRUE for safety — scheduler must pass false explicitly
  const cats = category === 'all'
    ? ['ai', 'saas', 'market', 'israel', 'crps', 'crypto']
    : [category];

  const header = `📰 <b>חדשות אישיות — ${dateHeader()}</b>`;
  const blocks  = [];

  await Promise.allSettled(
    cats.map(async (cat) => {
      const items = await fetchCategory(cat, ignoreDedup);
      const block = formatBlock(cat, items);
      if (block) blocks.push({ order: cats.indexOf(cat), text: block });
    })
  );

  // Preserve category order
  blocks.sort((a, b) => a.order - b.order);

  // Only show "no news" if ALL categories are empty
  if (!blocks.length) {
    return header + '\n\n🔄 אין חדשות זמינות כרגע. נסה שוב מאוחר יותר.';
  }

  return header + '\n\n' + blocks.map(b => b.text).join('\n\n');
}

// ── fetchAINews — backward-compat for scheduler.js (uses dedup) ──────────────

async function fetchAINews() {
  try {
    const { fetchAIDev: f } = require('./fetchers');
    const raw = await f(5);
    return filterAndMark(raw, false); // scheduler: apply dedup
  } catch { return []; }
}

// ── Skill execute ─────────────────────────────────────────────────────────────

async function execute(toolName, args, ctx) {
  if (toolName !== 'get_news') return `Unknown tool "${toolName}" in skill "${name}"`;
  const category = args?.category || 'all';
  try {
    console.log(`[Skills] news: building category="${category}"...`);
    const msg = await buildNewsMessage(category);
    if (ctx?.bot && ctx?.chatId) {
      await ctx.bot.sendMessage(ctx.chatId, msg, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      return `✅ חדשות נשלחו (${category})`;
    }
    return msg;
  } catch (err) {
    console.error('[Skills] news error:', err.message);
    return '⚠️ לא הצלחתי להביא חדשות כרגע.';
  }
}

module.exports = { name, description, tools, execute, buildNewsMessage, fetchAINews };
