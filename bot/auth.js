'use strict';

const crypto = require('crypto');
const { supabase, isEnabled } = require('./supabase');

const OWNER_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const TOKEN_TTL_MS   = 24 * 60 * 60 * 1000;
const SLIDING_THRESHOLD_MS = 12 * 60 * 60 * 1000;

// In-memory rate limit (per-process)
const failedAttempts = new Map();

function isOwner(chatId) {
  if (!OWNER_CHAT_ID) return false;
  return String(chatId) === OWNER_CHAT_ID;
}

async function createToken(chatId, userAgent = null, ip = null) {
  if (!isEnabled()) {
    throw new Error('Supabase not configured — auth disabled');
  }
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const { error } = await supabase.from('auth_tokens').insert({
    token,
    chat_id:    Number(chatId),
    expires_at: expiresAt,
    user_agent: userAgent,
    ip_address: ip,
  });
  if (error) {
    console.warn('[Auth] Failed to persist token:', error.message);
    throw new Error('Failed to create token');
  }

  console.log(`[Auth] Token ${token.slice(0, 8)}... created for chat ${chatId}`);
  return token;
}

async function verifyToken(token) {
  if (!token || !isEnabled()) return null;

  const { data, error } = await supabase
    .from('auth_tokens')
    .select('*')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;

  // Sliding expiry: if less than 12h left, extend to 24h
  const remainingMs = new Date(data.expires_at).getTime() - Date.now();
  const updates = { last_used_at: new Date().toISOString() };
  if (remainingMs < SLIDING_THRESHOLD_MS) {
    updates.expires_at = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  }
  await supabase.from('auth_tokens').update(updates).eq('token', token);

  return data.chat_id;
}

async function deleteToken(token) {
  if (!token || !isEnabled()) return;
  await supabase.from('auth_tokens').delete().eq('token', token);
  console.log(`[Auth] Token ${token.slice(0, 8)}... deleted`);
}

async function cleanupExpiredTokens() {
  if (!isEnabled()) return;
  const { error, count } = await supabase
    .from('auth_tokens')
    .delete({ count: 'exact' })
    .lt('expires_at', new Date().toISOString());
  if (!error && count > 0) {
    console.log(`[Auth] Cleaned up ${count} expired tokens`);
  }
}

function extractToken(req) {
  // 1. Cookie
  const cookie = req.headers.cookie || '';
  const cookieMatch = cookie.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('dashboard_token='));
  if (cookieMatch) return cookieMatch.slice('dashboard_token='.length);

  // 2. Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);

  // 3. Query string
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return url.searchParams.get('token');
  } catch {
    return null;
  }
}

function getClientIP(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isBlocked(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) return true;
  if (entry.resetAt < Date.now()) {
    failedAttempts.delete(ip);
    return false;
  }
  return false;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = failedAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  entry.count++;
  if (entry.count >= 5) {
    entry.blockedUntil = now + 60 * 60 * 1000;
    console.warn(`[Auth] 🚫 Blocked IP ${String(ip).slice(0, 10)}... after 5 failed attempts`);
  }
  failedAttempts.set(ip, entry);
}

function clearFailures(ip) {
  failedAttempts.delete(ip);
}

async function requireAuth(req, res, onSuccess, onDenyHtml = false) {
  const ip = getClientIP(req);

  if (isBlocked(ip)) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Too many failed attempts. Try again in 1 hour.' }));
    return;
  }

  const token  = extractToken(req);
  const chatId = await verifyToken(token);

  if (!chatId) {
    recordFailure(ip);
    if (onDenyHtml) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(DENIED_HTML);
    } else {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        error: 'Unauthorized',
        hint:  "Send 'דשבורד' to the Telegram bot for access",
      }));
    }
    return;
  }

  clearFailures(ip);
  req.chatId    = chatId;
  req.authToken = token;
  await onSuccess();
}

const DENIED_HTML = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>גישה מאובטחת — שילובילו</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap" rel="stylesheet">
  <style>body { font-family: 'Heebo', sans-serif; }</style>
</head>
<body class="bg-slate-950 text-white min-h-screen flex items-center justify-center p-4">
  <div class="max-w-md text-center">
    <div class="text-7xl mb-6">🔒</div>
    <h1 class="text-3xl font-bold mb-4">גישה מאובטחת</h1>
    <p class="text-slate-400 mb-8 leading-relaxed">
      הדשבורד מוגן בגישה אישית בלבד.<br>
      שלח
      <span class="inline-block bg-indigo-600/20 text-indigo-400 px-2 py-1 rounded font-mono text-sm mx-1">דשבורד</span>
      לבוט בטלגרם<br>
      כדי לקבל קישור מאובטח אישי
    </p>
    <div class="text-xs text-slate-600 mt-8">
      🛡️ הגנה באמצעות Token אישי + הגבלת ניסיונות
    </div>
  </div>
</body>
</html>`;

// Auto cleanup every hour
setInterval(() => {
  cleanupExpiredTokens().catch(e => console.warn('[Auth] cleanup error:', e.message));
}, 60 * 60 * 1000);

module.exports = {
  createToken,
  verifyToken,
  deleteToken,
  isOwner,
  extractToken,
  requireAuth,
  cleanupExpiredTokens,
};
