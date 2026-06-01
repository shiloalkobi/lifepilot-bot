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
 *   rankArticles, pickTop5, maybePrefixFlag below were byte-equivalent
 *   copies of the helpers in skills/research/index.js (the source of
 *   truth). Duplication is preferred over `require('../skills/research')
 *   ._internals` to keep the digest fully independent of the /research
 *   path — if skills/research/index.js evolves its ranking, this digest
 *   will NOT silently inherit the change. Any planned divergence or
 *   shared-helper extraction should update BOTH locations consciously.
 *
 * DELIBERATE DIVERGENCE (CRPS-11): the digest `scoreOf` below now adds a
 *   `_topicMatch` boost term (TOPIC_BOOST) that the skills/research copy does
 *   NOT have. The tier/Israeli/recency terms remain byte-equivalent, but the
 *   non-tier/non-Israel scoring is no longer byte-identical between the two
 *   copies. Rationale: the /research live-search path (index.js scoreOf) does
 *   not yet read topic subscriptions and is out of CRPS-11 MVP scope, so the
 *   boost is INTENTIONALLY digest-only. Re-syncing the two copies requires
 *   CRPS-11 follow-up work in skills/research/index.js. scoreOf stays a pure
 *   (article) → number; it reads a pre-computed `_topicMatch` field tagged in
 *   buildDigestMessage (no module-global, no signature change), preserving the
 *   _internals.scoreOf unit-test contract.
 */

const articlesStore = require('../skills/research/storage/articles');
const topicsStore = require('../skills/research/storage/topics');
const { matchesTopic, buildKeywordSet } = require('./research-topics');
const { isShabbatPrecise } = require('./shabbat');

const ISRAELI_FLAG_PREFIX = '🇮🇱 מגייס בישראל • ';
const TOPIC_MATCH_MARKER = '🎯 ';

// CRPS-11 topic-match boost. Set to 25 (< the 50 tier gap and < Israeli +30)
// so a topic match NEVER flips tier ordering: a Tier-2 + topic (50+25=75)
// stays below a plain Tier-1 (100), and Israeli-recruiting (+30) still leads
// within a tier. Tier > Israeli-recruiting > topic-interest, all within tier.
const TOPIC_BOOST = 25;

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
  if (a._topicMatch) s += TOPIC_BOOST;
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
  const store  = deps.articlesStore || articlesStore;
  const topics = deps.topicsStore  || topicsStore;
  const candidates = await store.findUnsurfaced(chatId, 50);
  if (!candidates || candidates.length === 0) {
    return { message: null, articleIds: [] };
  }

  // CRPS-11 — fetch active topic subscriptions ONCE, build the keyword set,
  // then PRE-TAG each candidate with a transient `_topicMatch` flag. scoreOf
  // reads that field (it never reads a module-global), so it stays pure. With
  // zero subscriptions the keyword set is [] → matchesTopic is false for all →
  // the digest behaves byte-identically to the pre-CRPS-11 ordering.
  let keywords = [];
  try {
    const topicRows = await topics.getActiveByChatId(chatId);
    keywords = buildKeywordSet(topicRows);
  } catch (e) {
    console.warn(`[Digest] topic fetch failed (boost skipped): ${e.message}`);
  }
  for (const a of candidates) a._topicMatch = matchesTopic(a, keywords);

  const ranked = rankArticles(candidates);
  const top    = pickTop5(ranked);

  const header = `🔬 <b>מחקרי CRPS השבוע</b> — מצאתי ${top.length} מאמרים חדשים`;
  const items  = top.map((a, i) => {
    const marker = a._topicMatch ? TOPIC_MATCH_MARKER : '';
    const lines = [`${i + 1}. ${marker}${maybePrefixFlag(a)}`];
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

  const { message, articleIds } = await buildDigestMessage(chatId, {
    articlesStore: store,
    topicsStore: deps.topicsStore,
  });
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
