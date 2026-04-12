'use strict';

/**
 * password-manager.js — AES-256-CBC encrypted password storage.
 * Key derived from TELEGRAM_BOT_TOKEN (first 32 chars, padded).
 * Data stored in data/passwords.json (all values encrypted).
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'passwords.json');
const ALG       = 'aes-256-cbc';
const IV_LEN    = 16;

// ── Key derivation ─────────────────────────────────────────────────────────────

function getKey() {
  const token = process.env.TELEGRAM_BOT_TOKEN || 'lifepilot-default-key-placeholder';
  // Pad/truncate to exactly 32 bytes for AES-256
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

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function persist(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

function savePassword(service, username, password) {
  const list    = load();
  const key     = service.toLowerCase();
  const idx     = list.findIndex(e => e.key === key);
  const entry   = {
    key,
    service:    service,
    username:   username ? encrypt(username) : '',
    password:   encrypt(password),
    updatedAt:  new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = entry;
  else          list.push(entry);
  persist(list);
}

function getPassword(service) {
  const key   = service.toLowerCase();
  const entry = load().find(e => e.key === key);
  if (!entry) return null;
  return {
    service:  entry.service,
    username: entry.username ? decrypt(entry.username) : '',
    password: decrypt(entry.password),
  };
}

function listPasswords() {
  return load().map(e => ({
    service:  e.service,
    username: e.username ? decrypt(e.username) : '',
  }));
}

function deletePassword(service) {
  const list    = load();
  const key     = service.toLowerCase();
  const filtered = list.filter(e => e.key !== key);
  if (filtered.length === list.length) return false;
  persist(filtered);
  return true;
}

module.exports = { savePassword, getPassword, listPasswords, deletePassword };
