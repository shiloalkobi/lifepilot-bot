'use strict';

/**
 * seen.js — tracks article URLs seen in the last 7 days.
 * Prevents the same article from appearing twice across days.
 */

const fs   = require('fs');
const path = require('path');

const SEEN_FILE = path.join(__dirname, '..', '..', 'data', 'news-seen.json');
const TTL_DAYS  = 7;

function todayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function load() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; }
}

function save(data) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function pruneOld(data) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TTL_DAYS);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  for (const key of Object.keys(data)) {
    if (key < cutoffStr) delete data[key];
  }
  return data;
}

/** Check if a URL has been seen in the last 7 days */
function hasSeen(url) {
  const data = load();
  const normalised = url.toLowerCase().split('?')[0]; // strip query params
  return Object.values(data).some(arr => arr.includes(normalised));
}

/** Mark URLs as seen for today */
function markSeen(urls) {
  let data = load();
  data = pruneOld(data);
  const today = todayKey();
  if (!data[today]) data[today] = [];
  const normalised = urls.map(u => u.toLowerCase().split('?')[0]);
  data[today].push(...normalised.filter(u => !data[today].includes(u)));
  save(data);
}

/** Filter an array of {url, ...} items to only unseen ones, then mark them seen */
function filterAndMark(items) {
  const fresh = items.filter(item => item.url && !hasSeen(item.url));
  if (fresh.length) markSeen(fresh.map(i => i.url));
  return fresh;
}

module.exports = { hasSeen, markSeen, filterAndMark };
