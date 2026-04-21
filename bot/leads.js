'use strict';

const fs   = require('fs');
const path = require('path');
const { supabase, isEnabled } = require('./supabase');

const DATA = path.join(__dirname, '../data/leads.json');

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

// Map Supabase row → in-memory lead shape (camelCase like before)
function rowToLead(r) {
  return {
    id:         r.id,
    title:      r.title,
    data:       r.data,
    status:     r.status,
    notes:      r.notes || '',
    createdAt:  r.created_at,
    followUpAt: r.follow_up_at,
    updatedAt:  r.updated_at,
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
    const { error } = await supabase.from('leads').insert({
      id:           lead.id,
      title:        lead.title,
      data:         lead.data,
      status:       lead.status,
      notes:        lead.notes,
      created_at:   lead.createdAt,
      follow_up_at: lead.followUpAt,
    });
    if (error) console.warn('[Supabase] saveLead error:', error.message);
  }

  // Always also write to JSON as a local backup
  try {
    const leads = loadLeadsFromJson();
    leads.push(lead);
    saveLeadsToJson(leads);
  } catch {}

  return lead;
}

async function updateLeadStatus(id, status) {
  if (isEnabled()) {
    const { data, error } = await supabase
      .from('leads')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (!error && data) {
      // mirror to JSON
      const leads = loadLeadsFromJson();
      const l = leads.find(x => x.id === id);
      if (l) { l.status = status; saveLeadsToJson(leads); }
      return rowToLead(data);
    }
    if (error) console.warn('[Supabase] updateLeadStatus error:', error.message);
  }

  const leads = loadLeadsFromJson();
  const lead  = leads.find(l => l.id === id);
  if (lead) { lead.status = status; saveLeadsToJson(leads); }
  return lead;
}

async function snoozeLead(id, hours = 24) {
  const followUpAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  if (isEnabled()) {
    const { data, error } = await supabase
      .from('leads')
      .update({ follow_up_at: followUpAt, status: 'new', updated_at: new Date().toISOString() })
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

  const patch = { updated_at: new Date().toISOString() };
  if (updates.status) { lead.status = updates.status; patch.status = updates.status; }
  if (updates.notes)  { lead.notes  = updates.notes;  patch.notes  = updates.notes; }
  lead.updatedAt = patch.updated_at;

  if (isEnabled()) {
    const { error } = await supabase.from('leads').update(patch).eq('id', lead.id);
    if (error) console.warn('[Supabase] updateLead error:', error.message);
  }

  // mirror to JSON
  const jsonLeads = loadLeadsFromJson();
  const jl = jsonLeads.find(l => l.id === lead.id);
  if (jl) {
    if (updates.status) jl.status = updates.status;
    if (updates.notes)  jl.notes  = updates.notes;
    jl.updatedAt = patch.updated_at;
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
