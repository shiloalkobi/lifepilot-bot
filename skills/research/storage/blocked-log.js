'use strict';

/**
 * research_blocked_log — append-only transparency ledger.
 * Receives every Tier 3 article (pre-filter or LLM classifier).
 * 1-year retention per Q23 (pruning is Phase 5+; not in 4d scope).
 */

const { supabase: defaultClient } = require('../../../bot/supabase');

const TABLE = 'research_blocked_log';

function getClient(injected) {
  const c = injected || defaultClient;
  if (!c) throw new Error('Supabase client unavailable');
  return c;
}

async function appendBlocked(entry, client = null) {
  const c = getClient(client);
  const row = {
    source:               entry.source,
    source_id:            entry.source_id,
    title:                entry.title,
    url:                  entry.url || null,
    blocked_by:           entry.blocked_by,           // 'pre_filter' | 'llm_classifier'
    reason_code:          entry.reason_code,
    classifier_rationale: entry.classifier_rationale || null,
  };
  if (!row.source || !row.source_id || !row.title || !row.blocked_by || !row.reason_code) {
    throw new Error('appendBlocked: missing required fields');
  }
  if (row.blocked_by !== 'pre_filter' && row.blocked_by !== 'llm_classifier') {
    throw new Error(`appendBlocked: invalid blocked_by "${row.blocked_by}"`);
  }
  const { data, error } = await c.from(TABLE).insert(row).select().single();
  if (error) throw new Error(`appendBlocked failed: ${error.message}`);
  return data;
}

async function countSince(sinceIso, client = null) {
  const c = getClient(client);
  const { count, error } = await c
    .from(TABLE)
    .select('*', { count: 'exact', head: true })
    .gte('blocked_at', sinceIso);
  if (error) throw new Error(`countSince failed: ${error.message}`);
  return count || 0;
}

async function deleteBySourceIdPrefix(prefix, client = null) {
  const c = getClient(client);
  if (!prefix) throw new Error('prefix required');
  const { error } = await c
    .from(TABLE)
    .delete()
    .like('source_id', `${prefix}%`);
  if (error) throw new Error(`deleteBySourceIdPrefix failed: ${error.message}`);
}

module.exports = {
  appendBlocked,
  countSince,
  deleteBySourceIdPrefix,
  TABLE,
};
