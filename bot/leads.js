'use strict';

const fs   = require('fs');
const path = require('path');
const { supabase, isEnabled } = require('./supabase');

const DATA = path.join(__dirname, '../data/leads.json');
const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null;

// ── JSON fallback ─────────────────────────────────────────────────────────────
function loadLeadsFromJson() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch { return []; }
}

function saveLeadsToJson(leads) {
  try {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    fs.writeFileSync(DATA, JSON.stringify(leads, null, 2));
  } catch (e) {
    console.warn('[leads] JSON save failed:', e.message);
  }
}

// Map Supabase row → in-memory lead (unpack data JSONB).
function rowToLead(r) {
  const d = r.data || {};
  return {
    id:         r.id,
    chat_id:    r.chat_id,
    title:      d.title || '',
    data:       d.fields || d.data || {},
    status:     d.status || 'new',
    notes:      d.notes || '',
    createdAt:  r.created_at,
    followUpAt: d.followUpAt,
    updatedAt:  r.updated_at,
  };
}

// Build the JSONB payload from a lead object.
function toDataPayload(lead) {
  return {
    title:      lead.title || '',
    status:     lead.status || 'new',
    notes:      lead.notes || '',
    followUpAt: lead.followUpAt || null,
    fields:     lead.data || {},
  };
}

// ── Public API ────────────────────────────────────────────────────────────────
async function loadLeads() {
  if (isEnabled()) {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error && Array.isArray(data)) return data.map(rowToLead);
    if (error) console.warn('[Supabase] loadLeads error:', error.message);
  }
  return loadLeadsFromJson();
}

async function saveLead(title, data) {
  const lead = {
    id:         Date.now().toString(36),
    title,
    data,
    status:     'new',
    createdAt:  new Date().toISOString(),
    followUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    notes:      '',
  };

  if (isEnabled()) {
    if (!OWNER_CHAT_ID) console.warn('[leads] TELEGRAM_CHAT_ID missing — row will have NULL chat_id');
    const { error } = await supabase.from('leads').insert({
      id:         lead.id,
      chat_id:    OWNER_CHAT_ID,
      data:       toDataPayload(lead),
      created_at: lead.createdAt,
      updated_at: lead.createdAt,
    });
    if (error) console.warn('[Supabase] saveLead error:', error.message);
  }

  // Always also write to JSON as a local backup
  try {
    const leads = loadLeadsFromJson();
    leads.push(lead);
    saveLeadsToJson(leads);
  } catch {}

  try { require('./metrics-history').invalidateCache(OWNER_CHAT_ID); } catch {}
  return lead;
}

async function updateLeadStatus(id, status) {
  const updatedAt = new Date().toISOString();

  if (isEnabled()) {
    const { data: existing, error: fetchErr } = await supabase
      .from('leads').select('*').eq('id', id).maybeSingle();
    if (!fetchErr && existing) {
      const newData = { ...(existing.data || {}), status };
      const { data, error } = await supabase
        .from('leads')
        .update({ data: newData, updated_at: updatedAt })
        .eq('id', id)
        .select()
        .single();
      if (!error && data) {
        const leads = loadLeadsFromJson();
        const l = leads.find(x => x.id === id);
        if (l) { l.status = status; saveLeadsToJson(leads); }
        return rowToLead(data);
      }
      if (error) console.warn('[Supabase] updateLeadStatus error:', error.message);
    }
  }

  const leads = loadLeadsFromJson();
  const lead  = leads.find(l => l.id === id);
  if (lead) { lead.status = status; saveLeadsToJson(leads); }
  return lead;
}

async function snoozeLead(id, hours = 24) {
  const followUpAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const updatedAt  = new Date().toISOString();

  if (isEnabled()) {
    const { data: existing, error: fetchErr } = await supabase
      .from('leads').select('*').eq('id', id).maybeSingle();
    if (!fetchErr && existing) {
      const newData = { ...(existing.data || {}), followUpAt, status: 'new' };
      const { data, error } = await supabase
        .from('leads')
        .update({ data: newData, updated_at: updatedAt })
        .eq('id', id)
        .select()
        .single();
      if (!error && data) {
        const leads = loadLeadsFromJson();
        const l = leads.find(x => x.id === id);
        if (l) { l.followUpAt = followUpAt; l.status = 'new'; saveLeadsToJson(leads); }
        return rowToLead(data);
      }
      if (error) console.warn('[Supabase] snoozeLead error:', error.message);
    }
  }

  const leads = loadLeadsFromJson();
  const lead  = leads.find(l => l.id === id);
  if (lead) {
    lead.followUpAt = followUpAt;
    lead.status     = 'new';
    saveLeadsToJson(leads);
  }
  return lead;
}

async function getNewLeads() {
  const leads = await loadLeads();
  return leads.filter(l => l.status === 'new');
}

async function getOverdueLeads() {
  const now = Date.now();
  const leads = await loadLeads();
  return leads.filter(l =>
    l.status === 'new' &&
    new Date(l.followUpAt).getTime() < now
  );
}

async function updateLead(idOrName, updates) {
  const leads = await loadLeads();
  const q = String(idOrName || '').toLowerCase();
  const lead = leads.find(l =>
    l.id === idOrName ||
    Object.values(l.data || {}).some(v => String(v).toLowerCase().includes(q))
  );
  if (!lead) return null;

  const updatedAt = new Date().toISOString();
  if (updates.status) lead.status = updates.status;
  if (updates.notes)  lead.notes  = updates.notes;
  lead.updatedAt = updatedAt;

  if (isEnabled()) {
    const newData = toDataPayload(lead);
    const { error } = await supabase
      .from('leads')
      .update({ data: newData, updated_at: updatedAt })
      .eq('id', lead.id);
    if (error) console.warn('[Supabase] updateLead error:', error.message);
  }

  // mirror to JSON
  const jsonLeads = loadLeadsFromJson();
  const jl = jsonLeads.find(l => l.id === lead.id);
  if (jl) {
    if (updates.status) jl.status = updates.status;
    if (updates.notes)  jl.notes  = updates.notes;
    jl.updatedAt = updatedAt;
    saveLeadsToJson(jsonLeads);
  }
  return lead;
}

async function searchLeads(query) {
  const q = String(query || '').toLowerCase();
  const leads = await loadLeads();
  return leads.filter(l =>
    Object.values(l.data || {}).some(v => String(v).toLowerCase().includes(q)) ||
    (l.title || '').toLowerCase().includes(q) ||
    (l.notes || '').toLowerCase().includes(q)
  );
}

async function getLeadsSummary() {
  const leads   = await loadLeads();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return {
    total:    leads.length,
    new:      leads.filter(l => l.status === 'new').length,
    closed:   leads.filter(l => l.status === 'closed').length,
    reminded: leads.filter(l => l.status === 'reminded').length,
    thisWeek: leads.filter(l => new Date(l.createdAt).getTime() > weekAgo).length,
    convRate: leads.length > 0
      ? Math.round(leads.filter(l => l.status === 'closed').length / leads.length * 100)
      : 0,
  };
}

module.exports = {
  saveLead, updateLeadStatus, snoozeLead, getNewLeads, getOverdueLeads, loadLeads,
  updateLead, searchLeads, getLeadsSummary,
};
