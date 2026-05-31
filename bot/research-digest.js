'use strict';

/**
 * CRPS-10 — Weekly Research Digest.
 *
 * Sunday 09:00 IL proactive Telegram message surfacing unsurfaced
 * Tier-1/2 research articles. Cron registration lives in
 * bot/proactive.js; this module owns the message builder + sender.
 *
 * STOP-list discipline (per docs/research/01h §4):
 *   - Zero modification to skills/research/index.js (search_research).
 *   - Zero modification to bot/telegram.js /research handler (the
 *     /digest_now manual trigger is a NEW handler, separate code path).
 *   - Zero modification to Hope Filter / classifier.
 *
 * INTENTIONAL DUPLICATION (per Phase B decision — Option B on §6 gap):
 *   rankArticles, pickTop5, maybePrefixFlag below are byte-equivalent
 *   copies of the helpers in skills/research/index.js (the source of
 *   truth). Duplication is preferred over `require('../skills/research')
 *   ._internals` to keep the digest fully independent of the /research
 *   path — if skills/research/index.js evolves its ranking, this digest
 *   will NOT silently inherit the change. Any planned divergence or
 *   shared-helper extraction should update BOTH locations consciously.
 */

const articlesStore = require('../skills/research/storage/articles');
const { isShabbatPrecise } = require('./shabbat');

const ISRAELI_FLAG_PREFIX = '🇮🇱 מגייס בישראל • ';

// ── Duplicated ranking helpers (source of truth: skills/research/index.js) ──

function isIsraeliRecruiting(article) {
  return !!(article && article._meta && article._meta.israel && article._meta.recruiting);
}

function maybePrefixFlag(article) {
  const baseTitle = article.title_he || article.title || '';
  return isIsraeliRecruiting(article) ? `${ISRAELI_FLAG_PREFIX}${baseTitle}` : baseTitle;
}

function scoreOf(a) {
  let s = 0;
  if (a.tier === 1) s += 100;
  else if (a.tier === 2) s += 50;
  if (isIsraeliRecruiting(a)) s += 30;
  const ts = a.published_at ? Date.parse(a.published_at) : NaN;
  if (Number.isFinite(ts)) s += ts / 1e13;
  return s;
}

function rankArticles(articles) {
  return [...articles].sort((a, b) => scoreOf(b) - scoreOf(a));
}

function pickTop5(ranked) {
  const tier1 = ranked.filter(a => a.tier === 1);
  const tier2 = ranked.filter(a => a.tier === 2);
  const out = [];
  for (const a of tier1.slice(0, 3)) out.push(a);
  for (const a of tier2.slice(0, Math.max(0, 5 - out.length))) out.push(a);
  let i1 = 3;
  while (out.length < 5 && i1 < tier1.length) {
    out.push(tier1[i1++]);
  }
  return out;
}

// ── Digest message builder ───────────────────────────────────────────────────

async function buildDigestMessage(chatId, deps = {}) {
  const store = deps.articlesStore || articlesStore;
  const candidates = await store.findUnsurfaced(chatId, 50);
  if (!candidates || candidates.length === 0) {
    return { message: null, articleIds: [] };
  }
  const ranked = rankArticles(candidates);
  const top    = pickTop5(ranked);

  const header = `🔬 <b>מחקרי CRPS השבוע</b> — מצאתי ${top.length} מאמרים חדשים`;
  const items  = top.map((a, i) => {
    const lines = [`${i + 1}. ${maybePrefixFlag(a)}`];
    if (a.framing_he) lines.push(`   <i>${a.framing_he}</i>`);
    lines.push(`   <a href="${a.url}">${a.source}</a>`);
    return lines.join('\n');
  });

  return {
    message: `${header}\n\n${items.join('\n\n')}`,
    articleIds: top.map(a => a.id).filter(Boolean),
  };
}

// ── Send wrapper ─────────────────────────────────────────────────────────────

async function sendWeeklyDigest(bot, chatId, deps = {}) {
  const store     = deps.articlesStore || articlesStore;
  const shabbatFn = deps.isShabbatPrecise || isShabbatPrecise;

  if (shabbatFn()) {
    console.log('[Digest] Shabbat — skipping');
    return { sent: false, reason: 'shabbat', articleIds: [] };
  }

  const { message, articleIds } = await buildDigestMessage(chatId, { articlesStore: store });
  if (!message) {
    console.log('[Digest] 0 unsurfaced articles — skipping');
    return { sent: false, reason: 'empty', articleIds: [] };
  }

  await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

  // Mark surfaced ONLY after successful send (don't burn the backlog on failure).
  for (const id of articleIds) {
    try { await store.markSurfaced(id, chatId); }
    catch (e) { console.warn(`[Digest] markSurfaced failed for ${id}: ${e.message}`); }
  }
  console.log(`[Digest] Sent ${articleIds.length} articles, marked surfaced`);
  return { sent: true, reason: 'ok', articleIds };
}

module.exports = {
  buildDigestMessage,
  sendWeeklyDigest,
  _internals: {
    isIsraeliRecruiting,
    maybePrefixFlag,
    scoreOf,
    rankArticles,
    pickTop5,
    ISRAELI_FLAG_PREFIX,
  },
};
