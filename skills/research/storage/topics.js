'use strict';

/**
 * research_topics CRUD.
 * Each row is a per-user subscription: (chat_id, topic) is UNIQUE.
 * Used by search_research to weight subscribed topics in ranking.
 */

const { supabase: defaultClient } = require('../../../bot/supabase');

const TABLE = 'research_topics';

function getClient(injected) {
  const c = injected || defaultClient;
  if (!c) throw new Error('Supabase client unavailable');
  return c;
}

async function upsertTopic(chatId, topic, keywords = [], active = true, client = null) {
  const c = getClient(client);
  const row = {
    chat_id:  chatId,
    topic:    String(topic).trim(),
    keywords: Array.isArray(keywords) ? keywords.map(k => String(k).trim()).filter(Boolean) : [],
    active:   !!active,
  };
  if (!row.topic) throw new Error('topic must be a non-empty string');
  const { data, error } = await c
    .from(TABLE)
    .upsert(row, { onConflict: 'chat_id,topic' })
    .select()
    .single();
  if (error) throw new Error(`upsertTopic failed: ${error.message}`);
  return data;
}

async function getActiveByChatId(chatId, client = null) {
  const c = getClient(client);
  const { data, error } = await c
    .from(TABLE)
    .select('*')
    .eq('chat_id', chatId)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getActiveByChatId failed: ${error.message}`);
  return data || [];
}

async function deactivate(chatId, topic, client = null) {
  const c = getClient(client);
  const { error } = await c
    .from(TABLE)
    .update({ active: false })
    .eq('chat_id', chatId)
    .eq('topic', topic);
  if (error) throw new Error(`deactivate failed: ${error.message}`);
}

async function deleteByChatIdAndTopicPrefix(chatId, prefix, client = null) {
  const c = getClient(client);
  if (!prefix) throw new Error('prefix required');
  const { error } = await c
    .from(TABLE)
    .delete()
    .eq('chat_id', chatId)
    .like('topic', `${prefix}%`);
  if (error) throw new Error(`deleteByChatIdAndTopicPrefix failed: ${error.message}`);
}

module.exports = {
  upsertTopic,
  getActiveByChatId,
  deactivate,
  deleteByChatIdAndTopicPrefix,
  TABLE,
};
