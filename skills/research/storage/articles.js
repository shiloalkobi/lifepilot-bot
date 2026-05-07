'use strict';

/**
 * research_articles CRUD.
 * All queries assume RLS+FORCE+0 policies (per 4a) and that the importing
 * process holds the service_role client from bot/supabase.js.
 *
 * Single-user bot: surfacing tracking is via the singular `surfaced_to_chat_id`
 * column. "Unseen for me" means surfaced_to_chat_id IS NULL OR != my chat_id.
 *
 * Tier 1 and Tier 2 articles live here; Tier 3 lives in research_blocked_log.
 *
 * NEVER logs the article body (abstract may contain PHI-adjacent content).
 * Only ids, sources, and tier values appear in console output.
 */

const { supabase: defaultClient, isEnabled } = require('../../../bot/supabase');

const TABLE = 'research_articles';

function getClient(injected) {
  const c = injected || defaultClient;
  if (!c) throw new Error('Supabase client unavailable (run with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
  return c;
}

async function upsertArticle(article, classification, client = null) {
  const c = getClient(client);
  const row = {
    source:                article.source,
    source_id:             article.source_id,
    title:                 article.title,
    abstract:              article.abstract,
    url:                   article.url,
    authors:               Array.isArray(article.authors) ? article.authors : [],
    published_at:          article.published_at || null,
    fetched_at:            new Date().toISOString(),
    tier:                  classification.tier,
    framing_he:            classification.framing_he || null,
    classifier_rationale:  classification.classifier_rationale || null,
  };
  const { data, error } = await c
    .from(TABLE)
    .upsert(row, { onConflict: 'source,source_id' })
    .select()
    .single();
  if (error) throw new Error(`upsertArticle failed: ${error.message}`);
  return data;
}

async function findBySourceAndId(source, source_id, client = null) {
  const c = getClient(client);
  const { data, error } = await c
    .from(TABLE)
    .select('*')
    .eq('source', source)
    .eq('source_id', source_id)
    .maybeSingle();
  if (error) throw new Error(`findBySourceAndId failed: ${error.message}`);
  return data;
}

async function findFreshUnseen(chatId, ttlHours = 6, client = null) {
  const c = getClient(client);
  const since = new Date(Date.now() - ttlHours * 3600 * 1000).toISOString();
  // Tier 1/2 articles fetched within TTL that THIS chat hasn't seen.
  // RLS service_role bypasses; the IS NULL OR != chatId expresses the
  // logical "not yet surfaced to me".
  const { data, error } = await c
    .from(TABLE)
    .select('*')
    .gte('fetched_at', since)
    .in('tier', [1, 2])
    .or(`surfaced_to_chat_id.is.null,surfaced_to_chat_id.neq.${chatId}`)
    .order('tier', { ascending: true })
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) throw new Error(`findFreshUnseen failed: ${error.message}`);
  return data || [];
}

async function markSurfaced(id, chatId, client = null) {
  const c = getClient(client);
  const { error } = await c
    .from(TABLE)
    .update({
      surfaced_to_chat_id: chatId,
      surfaced_at:         new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`markSurfaced failed: ${error.message}`);
}

async function getHistory(chatId, limit = 10, client = null) {
  const c = getClient(client);
  const { data, error } = await c
    .from(TABLE)
    .select('*')
    .eq('surfaced_to_chat_id', chatId)
    .order('surfaced_at', { ascending: false })
    .limit(Math.min(Math.max(1, Number(limit) || 10), 50));
  if (error) throw new Error(`getHistory failed: ${error.message}`);
  return data || [];
}

async function deleteBySourceIdPrefix(prefix, client = null) {
  // Test-data cleanup helper. Uses LIKE on source_id, so prefix must NOT
  // contain wildcards or unescaped underscores.
  const c = getClient(client);
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error('deleteBySourceIdPrefix requires non-empty string prefix');
  }
  const { error } = await c
    .from(TABLE)
    .delete()
    .like('source_id', `${prefix}%`);
  if (error) throw new Error(`deleteBySourceIdPrefix failed: ${error.message}`);
}

module.exports = {
  upsertArticle,
  findBySourceAndId,
  findFreshUnseen,
  markSurfaced,
  getHistory,
  deleteBySourceIdPrefix,
  isEnabled,
  TABLE,
};
