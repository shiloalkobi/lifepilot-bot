'use strict';

const fs   = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '../data/leads.json');

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch { return []; }
}

function saveLeads(leads) {
  fs.writeFileSync(DATA, JSON.stringify(leads, null, 2));
}

function saveLead(title, data) {
  const leads = loadLeads();
  const lead = {
    id:          Date.now().toString(36),
    title,
    data,
    status:      'new',
    createdAt:   new Date().toISOString(),
    followUpAt:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    notes:       '',
  };
  leads.push(lead);
  saveLeads(leads);
  return lead;
}

function updateLeadStatus(id, status) {
  const leads = loadLeads();
  const lead  = leads.find(l => l.id === id);
  if (lead) { lead.status = status; saveLeads(leads); }
  return lead;
}

function snoozeLead(id, hours = 24) {
  const leads = loadLeads();
  const lead  = leads.find(l => l.id === id);
  if (lead) {
    lead.followUpAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    lead.status     = 'new'; // reset from reminded
    saveLeads(leads);
  }
  return lead;
}

function getNewLeads() {
  return loadLeads().filter(l => l.status === 'new');
}

function getOverdueLeads() {
  const now = Date.now();
  return loadLeads().filter(l =>
    l.status === 'new' &&
    new Date(l.followUpAt).getTime() < now
  );
}

function updateLead(idOrName, updates) {
  const leads = loadLeads();
  const q = String(idOrName || '').toLowerCase();
  const lead = leads.find(l =>
    l.id === idOrName ||
    Object.values(l.data).some(v => String(v).toLowerCase().includes(q))
  );
  if (!lead) return null;
  if (updates.status) lead.status = updates.status;
  if (updates.notes)  lead.notes  = updates.notes;
  lead.updatedAt = new Date().toISOString();
  saveLeads(leads);
  return lead;
}

function searchLeads(query) {
  const q = String(query || '').toLowerCase();
  return loadLeads().filter(l =>
    Object.values(l.data).some(v => String(v).toLowerCase().includes(q)) ||
    l.title.toLowerCase().includes(q) ||
    (l.notes || '').toLowerCase().includes(q)
  );
}

function getLeadsSummary() {
  const leads   = loadLeads();
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
