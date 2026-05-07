'use strict';

/**
 * research skill — entry point.
 *
 * Registers 4 EXTENDED-tier tools per docs/research/01b §5:
 *   - search_research            (main)
 *   - subscribe_research_topic
 *   - get_research_history
 *   - set_research_profile       (with confirmation flow per Q20 + US10)
 *
 * search_research orchestrates the 11-step flow per 01c §8 sub-phase 4d Task 3:
 *   cache → adapters → classifier (with retry) → store → rank → top-5 →
 *   surface → disclaimer.
 *
 * Israeli recruiting trial flag (US09): rendered onto title_he when
 * `_meta.israel && _meta.recruiting` is present. _meta is transient (only
 * available for fresh-fetched CT.gov articles); cached articles do not
 * carry it. See 01d §"Sub-phase 4d" honest gap notes.
 */

const pubmed         = require('./sources/pubmed');
const clinicaltrials = require('./sources/clinicaltrials');
const medrxiv        = require('./sources/medrxiv');

const { classifyArticle } = require('./filter/tiers');

const articlesStore = require('./storage/articles');
const topicsStore   = require('./storage/topics');
const profileStore  = require('./storage/profile');
const blockedStore  = require('./storage/blocked-log');

const DEFAULT_ADAPTERS = [pubmed, clinicaltrials, medrxiv];

const name        = 'research';
const description = 'CRPS research search — emotionally filtered, Hebrew-summary results.';

const tools = [
  {
    name:        'search_research',
    description: 'מחקר CRPS מסונן רגשית. כותרת/נושא/רענון.',
    parameters: {
      type: 'object',
      properties: {
        query:   { type: 'string',  description: 'free-text query (Hebrew or English); optional' },
        topic:   { type: 'string',  description: 'subscribed topic id; optional' },
        refresh: { type: 'boolean', description: 'bypass 6h cache; default false' },
      },
      required: [],
    },
  },
  {
    name:        'subscribe_research_topic',
    description: 'מנוי לנושא CRPS — מילות מפתח לחיפוש.',
    parameters: {
      type: 'object',
      properties: {
        topic:    { type: 'string',  description: 'short label, e.g., "ketamine"' },
        keywords: { type: 'array',   items: { type: 'string' }, description: 'expansion search terms' },
        active:   { type: 'boolean', description: 'enable immediately; default true' },
      },
      required: ['topic'],
    },
  },
  {
    name:        'get_research_history',
    description: 'מאמרים שכבר הוצגו — היסטוריה.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'default 10' },
      },
      required: [],
    },
  },
  {
    name:        'set_research_profile',
    description: 'עדכון פרופיל מחקר אישי — טיפולים והעדפות.',
    parameters: {
      type: 'object',
      properties: {
        profile_he:  { type: 'string',  description: 'free-text Hebrew profile' },
        treatments:  { type: 'array',   items: { type: 'string' }, description: 'treatments list' },
        preferences: { type: 'object',  description: 'flat preferences object' },
        confirmed:   { type: 'boolean', description: 'set true to confirm previously-proposed treatment changes' },
      },
      required: [],
    },
  },
];

const DISCLAIMER_HE =
  '⚕️ הבהרה: המידע שמוצג כאן הוא מידע מחקרי כללי, לא ייעוץ רפואי. ' +
  'אל תשנה טיפול קיים ללא התייעצות עם הצוות הרפואי המטפל.';

const ISRAELI_FLAG_PREFIX = '🇮🇱 מגייס בישראל • ';

function isIsraeliRecruiting(article) {
  return !!(article && article._meta && article._meta.israel && article._meta.recruiting);
}

function maybePrefixFlag(article) {
  const baseTitle = article.title_he || article.title || '';
  return isIsraeliRecruiting(article) ? `${ISRAELI_FLAG_PREFIX}${baseTitle}` : baseTitle;
}

// Sort score: Tier 1 > Tier 2; +30 for Israeli recruiting; recency tiebreaker.
function scoreOf(a) {
  let s = 0;
  if (a.tier === 1) s += 100;
  else if (a.tier === 2) s += 50;
  if (isIsraeliRecruiting(a)) s += 30;
  const ts = a.published_at ? Date.parse(a.published_at) : NaN;
  if (Number.isFinite(ts)) s += ts / 1e13; // tiny tiebreaker; never enough to flip tier
  return s;
}

function rankArticles(articles) {
  return [...articles].sort((a, b) => scoreOf(b) - scoreOf(a));
}

function pickTop5(ranked) {
  // Aim for 3 Tier-1 + 2 Tier-2 per Q1; fall back to whatever's available.
  const tier1 = ranked.filter(a => a.tier === 1);
  const tier2 = ranked.filter(a => a.tier === 2);
  const out = [];
  for (const a of tier1.slice(0, 3)) out.push(a);
  for (const a of tier2.slice(0, Math.max(0, 5 - out.length))) out.push(a);
  // If still <5 and we have more Tier-1 leftover, fill from there.
  let i1 = 3;
  while (out.length < 5 && i1 < tier1.length) {
    out.push(tier1[i1++]);
  }
  return out;
}

// Retry-once-with-backoff per 4c.G1 lesson — only for transport errors,
// never for fail-safe-coerced tier-3 results.
async function classifyWithRetry(classify, article, profile) {
  try {
    return await classify(article, profile || {});
  } catch (e1) {
    await new Promise(r => setTimeout(r, 1000));
    return classify(article, profile || {});
  }
}

// ── search_research ───────────────────────────────────────────────────────────

async function searchResearch(args, ctx, deps = {}) {
  const chatId = resolveChatId(ctx, args);
  if (!chatId) throw new Error('chat_id missing');

  const refresh = !!args.refresh;
  const query   = args.query ? String(args.query).trim() : null;

  const adapters = deps.adapters       || DEFAULT_ADAPTERS;
  const classify = deps.classifyArticle || classifyArticle;
  const store    = deps.articlesStore   || articlesStore;
  const blocked  = deps.blockedStore    || blockedStore;
  const profile  = deps.profileStore    || profileStore;

  // Q27 (a): lazy-create profile on first /research call.
  await profile.ensureProfile(chatId);

  let articles = [];
  if (!refresh) {
    try {
      articles = await store.findFreshUnseen(chatId);
    } catch (e) {
      console.warn(`[research] cache lookup failed: ${e.message}`);
    }
  }

  let blockedCount = 0;

  if (articles.length < 5 || refresh) {
    const userProfile = await profile.getProfile(chatId);

    const adapterResults = await Promise.all(adapters.map(a =>
      a.fetch(query, null).catch(err => {
        console.warn(`[research] adapter ${a.name} fetch failed: ${err.message}`);
        return [];
      }),
    ));
    const fetched = adapterResults.flat();

    // Dedup vs already-cached (don't classify the same article twice).
    const seen = new Set(articles.map(a => `${a.source}|${a.source_id}`));
    const fresh = fetched.filter(a => !seen.has(`${a.source}|${a.source_id}`));

    for (const article of fresh) {
      let classification;
      try {
        classification = await classifyWithRetry(classify, article, userProfile);
      } catch (e) {
        console.warn(`[research] classify failed (twice) for ${article.source}/${article.source_id}: ${e.message}`);
        continue;
      }

      if (classification.tier === 3) {
        try {
          await blocked.appendBlocked({
            source:               article.source,
            source_id:            article.source_id,
            title:                article.title,
            url:                  article.url,
            blocked_by:           classification.blocked_by || 'llm_classifier',
            reason_code:          classification.block_reason || 'unknown',
            classifier_rationale: classification.classifier_rationale,
          });
        } catch (e) {
          console.warn(`[research] blocked_log append failed: ${e.message}`);
        }
        blockedCount++;
        continue;
      }

      try {
        const saved = await store.upsertArticle(article, classification);
        // Carry _meta forward in-memory for this round's ranking and flag rendering.
        articles.push({ ...saved, _meta: article._meta });
      } catch (e) {
        console.warn(`[research] upsertArticle failed for ${article.source}/${article.source_id}: ${e.message}`);
      }
    }
  }

  const ranked = rankArticles(articles);
  const top    = pickTop5(ranked);

  for (const a of top) {
    if (a.id) {
      try { await store.markSurfaced(a.id, chatId); }
      catch (e) { console.warn(`[research] markSurfaced failed for ${a.id}: ${e.message}`); }
    }
  }

  let disclaimer = null;
  try {
    if (await profile.needsDisclaimer(chatId)) {
      disclaimer = DISCLAIMER_HE;
      await profile.markDisclaimerShown(chatId);
    }
  } catch (e) {
    console.warn(`[research] disclaimer check failed: ${e.message}`);
  }

  return {
    ok: true,
    articles: top.map(a => ({
      tier:               a.tier,
      title_he:           maybePrefixFlag(a),
      title_en:           a.title,
      summary_he:         a.framing_he || null,
      url:                a.url,
      source:             a.source,
      published_at:       a.published_at,
      israeli_recruiting: isIsraeliRecruiting(a),
    })),
    blocked_count: blockedCount,
    disclaimer_he: disclaimer,
  };
}

// ── subscribe_research_topic ──────────────────────────────────────────────────

async function subscribeTopic(args, ctx, deps = {}) {
  const chatId = resolveChatId(ctx, args);
  if (!chatId) throw new Error('chat_id missing');
  if (!args.topic) throw new Error('topic argument required');
  const store = deps.topicsStore || topicsStore;
  const row = await store.upsertTopic(
    chatId,
    args.topic,
    Array.isArray(args.keywords) ? args.keywords : [],
    args.active !== false,
  );
  return { ok: true, topic: row.topic, active: row.active, keywords: row.keywords };
}

// ── get_research_history ──────────────────────────────────────────────────────

async function getHistory(args, ctx, deps = {}) {
  const chatId = resolveChatId(ctx, args);
  if (!chatId) throw new Error('chat_id missing');
  const limit = Number.isInteger(args.limit) ? args.limit : 10;
  const store = deps.articlesStore || articlesStore;
  const rows = await store.getHistory(chatId, limit);
  return {
    ok: true,
    articles: rows.map(a => ({
      tier:        a.tier,
      title:       a.title,
      url:         a.url,
      source:      a.source,
      surfaced_at: a.surfaced_at,
    })),
  };
}

// ── set_research_profile (Q20 + US10 confirmation flow) ──────────────────────

async function setProfile(args, ctx, deps = {}) {
  const chatId = resolveChatId(ctx, args);
  if (!chatId) throw new Error('chat_id missing');
  const store = deps.profileStore || profileStore;

  const result = await store.applyProfileUpdate(chatId, {
    profile_he:  args.profile_he,
    treatments:  args.treatments,
    preferences: args.preferences,
    confirmed:   args.confirmed,
  });

  if (result.confirmation_needed) {
    const before = result.proposed_changes.treatments_before || [];
    const after  = result.proposed_changes.treatments_after  || [];
    return {
      ok: true,
      confirmation_needed: true,
      proposed_changes: result.proposed_changes,
      confirmation_message_he: [
        'אישור נדרש לשינוי הטיפולים שלך:',
        `נוכחי: ${before.length ? before.join(', ') : '(ריק)'}`,
        `מוצע: ${after.length  ? after.join(', ')  : '(ריק)'}`,
        'אנא ענה "אישור" או "כן" לאישור — בלי תשובה הטיפולים לא ישתנו.',
      ].join('\n'),
    };
  }

  return { ok: true, saved: !!result.saved, treatments_changed: !!result.treatments_changed };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function resolveChatId(ctx, args) {
  if (ctx && (ctx.chat_id != null)) return ctx.chat_id;
  if (args && (args.chat_id != null)) return args.chat_id;
  return null;
}

// ── execute() — skill loader entry point ─────────────────────────────────────

async function execute(toolName, args = {}, ctx = {}) {
  try {
    switch (toolName) {
      case 'search_research':          return await searchResearch(args, ctx);
      case 'subscribe_research_topic': return await subscribeTopic(args, ctx);
      case 'get_research_history':     return await getHistory(args, ctx);
      case 'set_research_profile':     return await setProfile(args, ctx);
      default:
        return { ok: false, error: `Unknown tool "${toolName}" in skill "${name}"` };
    }
  } catch (err) {
    // PHI hygiene: only the err.message goes out, never the raw args object.
    console.error(`[research] ${toolName} error: ${err.message}`);
    return { ok: false, error: `${toolName} failed: ${err.message}` };
  }
}

module.exports = {
  name,
  description,
  tools,
  execute,
  // Internals exposed for testing only:
  _internals: {
    searchResearch,
    subscribeTopic,
    getHistory,
    setProfile,
    rankArticles,
    pickTop5,
    scoreOf,
    maybePrefixFlag,
    isIsraeliRecruiting,
    classifyWithRetry,
    DISCLAIMER_HE,
    ISRAELI_FLAG_PREFIX,
  },
};
