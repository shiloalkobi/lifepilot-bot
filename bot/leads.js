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

module.exports = { saveLead, updateLeadStatus, snoozeLead, getNewLeads, getOverdueLeads, loadLeads };
