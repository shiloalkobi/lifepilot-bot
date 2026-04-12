'use strict';

/**
 * news skill — production-grade 4-category news system.
 *
 * Categories:
 *   ai      — AI & Dev Tools     (HN Algolia + Simon Willison)
 *   saas    — SaaS & Startups    (TechCrunch + HN)
 *   market  — Markets & Finance  (Yahoo Finance + Investing.com)
 *   israel  — Israeli Tech       (Globes + Calcalist)
 *
 * Anti-duplication: data/news-seen.json tracks URLs for 7 days.
 */

const { fetchAIDev, fetchSaaS, fetchMarkets, fetchIsraelTech, domain } = require('./fetchers');
const { filterAndMark } = require('./seen');

const name        = 'news';
const description = 'Production 4-category news: AI, SaaS, Markets, Israeli Tech. Anti-duplicate.';

const tools = [
  {
    name:        'get_news',
    description: 'הבא חדשות: ai / saas / market / israel / all.',
    parameters: {
      type:       'object',
      properties: {
        category: {
          type: 'string',
          enum: ['ai', 'saas', 'market', 'israel', 'all'],
          description: 'ברירת מחדל: all',
        },
      },
      required: [],
    },
  },
];

// ── Hebrew date header ────────────────────────────────────────────────────────

function dateHeader() {
  const d = new Date();
  return d.toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday:  'long',
    day:      'numeric',
    month:    'numeric',
  });
}

// ── Format a category block ───────────────────────────────────────────────────

function formatBlock(emoji, title, items) {
  if (!items || !items.length) return null;
  const lines = [`${emoji} <b>${title}:</b>`];
  for (const item of items) {
    const src = item.source ? ` <i>[${item.source}]</i>` : '';
    lines.push(`• <a href="${item.url}">${item.title}</a>${src}`);
  }
  return lines.join('\n');
}

// ── Fetch one category (with dedup) ──────────────────────────────────────────

async function fetchCategory(cat) {
  let raw = [];
  if (cat === 'ai')     raw = await fetchAIDev(5).catch(() => []);
  if (cat === 'saas')   raw = await fetchSaaS(4).catch(() => []);
  if (cat === 'market') raw = await fetchMarkets(5).catch(() => []);
  if (cat === 'israel') raw = await fetchIsraelTech(4).catch(() => []);
  return filterAndMark(raw); // removes already-seen, marks new ones
}

// ── Build a formatted news message ───────────────────────────────────────────

async function buildNewsMessage(category = 'all') {
  const cats = category === 'all'
    ? ['ai', 'saas', 'market', 'israel']
    : [category];

  const header = `📰 <b>חדשות — ${dateHeader()}</b>\n`;
  const blocks  = [];

  const META = {
    ai:     { emoji: '🤖', title: 'AI & פיתוח' },
    saas:   { emoji: '🚀', title: 'SaaS & סטארטאפים' },
    market: { emoji: '📈', title: 'שוק ההון' },
    israel: { emoji: '🇮🇱', title: 'ישראל טק' },
  };

  for (const cat of cats) {
    const items = await fetchCategory(cat);
    const block = formatBlock(META[cat].emoji, META[cat].title, items);
    if (block) blocks.push(block);
  }

  if (!blocks.length) {
    return header + '\n🔄 אין חדשות חדשות כרגע — כל הכתבות כבר נראו היום.';
  }

  return header + '\n' + blocks.join('\n\n');
}

// ── fetchAINews (backward-compat for scheduler.js) ────────────────────────────

async function fetchAINews() {
  try {
    const raw = await fetchAIDev(5);
    return filterAndMark(raw);
  } catch { return []; }
}

// ── Skill execute ─────────────────────────────────────────────────────────────

async function execute(toolName, args, ctx) {
  if (toolName !== 'get_news') return `Unknown tool "${toolName}" in skill "${name}"`;
  const category = args?.category || 'all';
  try {
    console.log(`[Skills] news: fetching category="${category}"...`);
    const msg = await buildNewsMessage(category);
    // Send via bot if ctx available, else return text
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
