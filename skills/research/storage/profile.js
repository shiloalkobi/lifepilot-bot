'use strict';

/**
 * research_user_profile CRUD.
 *
 * SENSITIVE PHI — `profile_he` and `treatments` describe the user's medical
 * context. Do NOT include either in console.log, error messages, or thrown
 * Error.message values. The DB has RLS+FORCE+0 policies (service_role only)
 * per docs/security/01f Rule 1; this module respects PHI hygiene at the
 * application layer too.
 *
 * Confirmation flow (Q20 + US10): when `treatments` changes, callers MUST
 * pass `confirmed=true` to actually persist. Without `confirmed`, the
 * update returns a "would-be" diff and changes nothing in the DB.
 */

const { supabase: defaultClient } = require('../../../bot/supabase');

const TABLE = 'research_user_profile';

function getClient(injected) {
  const c = injected || defaultClient;
  if (!c) throw new Error('Supabase client unavailable');
  return c;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

async function getProfile(chatId, client = null) {
  const c = getClient(client);
  const { data, error } = await c
    .from(TABLE)
    .select('*')
    .eq('chat_id', chatId)
    .maybeSingle();
  if (error) throw new Error(`getProfile failed: ${error.message}`);
  return data;
}

async function ensureProfile(chatId, client = null) {
  // Lazy bootstrap (per Q27 (a)): on first call, create empty profile.
  const existing = await getProfile(chatId, client);
  if (existing) return existing;
  const c = getClient(client);
  const { data, error } = await c
    .from(TABLE)
    .insert({ chat_id: chatId })
    .select()
    .single();
  if (error) throw new Error(`ensureProfile failed: ${error.message}`);
  return data;
}

/**
 * Apply profile updates with confirmation gate for treatments.
 *
 * @returns {Promise<{ saved: boolean, confirmation_needed?: boolean,
 *                     proposed_changes?: object, profile?: object }>}
 *   - If `treatments` would change and `confirmed !== true` → no DB write,
 *     returns { saved: false, confirmation_needed: true, proposed_changes }.
 *   - Otherwise → DB write, returns { saved: true, profile }.
 */
async function applyProfileUpdate(chatId, updates, client = null) {
  const c = getClient(client);
  const current = await ensureProfile(chatId, c);

  const next = {};
  let treatmentsChanging = false;

  if (updates.profile_he !== undefined) {
    next.profile_he = updates.profile_he == null ? null : String(updates.profile_he);
  }
  if (updates.preferences !== undefined) {
    next.preferences = updates.preferences && typeof updates.preferences === 'object'
      ? updates.preferences
      : {};
  }
  if (updates.treatments !== undefined) {
    const newT = Array.isArray(updates.treatments)
      ? updates.treatments.map(t => String(t).trim()).filter(Boolean)
      : [];
    if (!arraysEqual(current.treatments || [], newT)) {
      treatmentsChanging = true;
      if (updates.confirmed !== true) {
        // Q20: do NOT save treatments without explicit confirmation.
        return {
          saved: false,
          confirmation_needed: true,
          proposed_changes: {
            treatments_before: current.treatments || [],
            treatments_after:  newT,
          },
        };
      }
      next.treatments = newT;
    }
  }

  if (Object.keys(next).length === 0) {
    return { saved: false, profile: current };
  }

  const { data, error } = await c
    .from(TABLE)
    .update(next)
    .eq('chat_id', chatId)
    .select()
    .single();
  if (error) {
    // Hide DB error message to avoid surfacing PHI accidentally; log a redacted form.
    console.error('[research/profile] applyProfileUpdate DB error (redacted)');
    throw new Error('applyProfileUpdate failed: DB write error');
  }
  return { saved: true, profile: data, treatments_changed: treatmentsChanging };
}

async function markDisclaimerShown(chatId, client = null) {
  const c = getClient(client);
  await ensureProfile(chatId, c);
  const { error } = await c
    .from(TABLE)
    .update({ last_disclaimer_seen: new Date().toISOString() })
    .eq('chat_id', chatId);
  if (error) throw new Error(`markDisclaimerShown failed: ${error.message}`);
}

function isSameDayInIL(isoTimestamp) {
  if (!isoTimestamp) return false;
  // Compare both via Asia/Jerusalem locale — naive approach: format as YYYY-MM-DD
  // in IL tz and compare strings.
  const fmt = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  try {
    return fmt(new Date(isoTimestamp)) === fmt(new Date());
  } catch {
    return false;
  }
}

async function needsDisclaimer(chatId, client = null) {
  const profile = await getProfile(chatId, client);
  if (!profile) return true; // no profile yet → first visit → show
  return !isSameDayInIL(profile.last_disclaimer_seen);
}

async function deleteProfile(chatId, client = null) {
  const c = getClient(client);
  const { error } = await c.from(TABLE).delete().eq('chat_id', chatId);
  if (error) throw new Error(`deleteProfile failed: ${error.message}`);
}

module.exports = {
  getProfile,
  ensureProfile,
  applyProfileUpdate,
  markDisclaimerShown,
  needsDisclaimer,
  isSameDayInIL,
  deleteProfile,
  TABLE,
};
