'use strict';

/**
 * password-manager.js — AES-256-CBC encrypted password storage.
 * Key derived from TELEGRAM_BOT_TOKEN (first 32 chars, padded).
 * Data stored in Supabase (passwords table) with JSON fallback.
 * Values remain encrypted at rest either way.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { supabase, isEnabled } = require('./supabase');

const DATA_FILE = path.join(__dirname, '..', 'data', 'passwords.json');
const ALG       = 'aes-256-cbc';
const IV_LEN    = 16;

// ── Key derivation ─────────────────────────────────────────────────────────────

function getKey() {
  const token = process.env.TELEGRAM_BOT_TOKEN || 'lifepilot-default-key-placeholder';
  return Buffer.from(token.slice(0, 32).padEnd(32, '0'), 'utf8');
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

function encrypt(text) {
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const enc    = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(encrypted) {
  const [ivHex, dataHex] = encrypted.split(':');
  const iv       = Buffer.from(ivHex, 'hex');
  const data     = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALG, getKey(), iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ── Storage ───────────────────────────────────────────────────────────────────

function loadFromJson() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function persistToJson(list) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.warn('[passwords] JSON save failed:', e.message);
  }
}

function rowToEntry(r) {
  return {
    key:       r.key,
    service:   r.service,
    username:  r.username || '',
    password:  r.password,
    updatedAt: r.updated_at,
  };
}

async function load() {
  if (isEnabled()) {
    const { data, error } = await supabase.from('passwords').select('*');
    if (!error && Array.isArray(data)) return data.map(rowToEntry);
    if (error) console.warn('[Supabase] passwords load error:', error.message);
  }
  return loadFromJson();
}

// ── Public API ────────────────────────────────────────────────────────────────

async function savePassword(service, username, password) {
  const key = service.toLowerCase();
  const entry = {
    key,
    service,
    username:  username ? encrypt(username) : '',
    password:  encrypt(password),
    updatedAt: new Date().toISOString(),
  };

  if (isEnabled()) {
    const { error } = await supabase.from('passwords').upsert({
      key:        entry.key,
      service:    entry.service,
      username:   entry.username,
      password:   entry.password,
      updated_at: entry.updatedAt,
    }, { onConflict: 'key' });
    if (error) console.warn('[Supabase] savePassword error:', error.message);
  }

  const list = loadFromJson();
  const idx  = list.findIndex(e => e.key === key);
  if (idx >= 0) list[idx] = entry;
  else          list.push(entry);
  persistToJson(list);
}

async function getPassword(service) {
  const key   = service.toLowerCase();
  const list  = await load();
  const entry = list.find(e => e.key === key);
  if (!entry) return null;
  return {
    service:  entry.service,
    username: entry.username ? decrypt(entry.username) : '',
    password: decrypt(entry.password),
  };
}

async function listPasswords() {
  const list = await load();
  return list.map(e => ({
    service:  e.service,
    username: e.username ? decrypt(e.username) : '',
  }));
}

async function deletePassword(service) {
  const key = service.toLowerCase();

  if (isEnabled()) {
    const { error } = await supabase.from('passwords').delete().eq('key', key);
    if (error) console.warn('[Supabase] deletePassword error:', error.message);
  }

  const list     = loadFromJson();
  const filtered = list.filter(e => e.key !== key);
  const removed  = filtered.length !== list.length;
  persistToJson(filtered);
  return removed;
}

module.exports = { savePassword, getPassword, listPasswords, deletePassword };
