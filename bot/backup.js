'use strict';

const { supabase, isEnabled } = require('./supabase');

// Whitelist — auth_tokens, passwords, and backups itself are excluded by design.
const BACKUP_TABLES = [
  'tasks', 'habits', 'health_logs', 'expenses',
  'leads', 'memory', 'watchlist',
];

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID
  ? Number(process.env.TELEGRAM_CHAT_ID)
  : null;

function generateBackupId(trigger) {
  const now = new Date();
  if (trigger === 'auto') {
    return `bkp_auto_${now.toISOString().slice(0, 10)}`;
  }
  return `bkp_manual_${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

async function alreadyBackedUpToday() {
  if (!isEnabled()) return false;
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('backups')
    .select('id')
    .eq('id', `bkp_auto_${today}`)
    .maybeSingle();
  return !!data;
}

// Defensive: even if someone adds 'passwords' to BACKUP_TABLES later,
// plaintext values are stripped here.
async function snapshotTable(tableName) {
  const { data, error } = await supabase.from(tableName).select('*');
  if (error) throw new Error(`${tableName}: ${error.message}`);

  if (tableName === 'passwords' && Array.isArray(data)) {
    return data.map(row => ({
      ...row,
      data: { ...(row.data || {}), value: '[REDACTED]' },
    }));
  }
  return data || [];
}

async function performBackup(trigger = 'auto') {
  if (!isEnabled()) return { success: false, error: 'Supabase not enabled' };

  if (trigger === 'auto' && await alreadyBackedUpToday()) {
    console.log('[Backup] Auto backup already exists for today — skipping');
    return { success: true, skipped: true };
  }

  const started = Date.now();
  const id = generateBackupId(trigger);
  const tables = {};
  const recordCounts = {};
  const errors = [];

  for (const tableName of BACKUP_TABLES) {
    try {
      const rows = await snapshotTable(tableName);
      tables[tableName] = rows;
      recordCounts[tableName] = rows.length;
    } catch (e) {
      errors.push({ table: tableName, error: e.message });
      console.warn(`[Backup] ${tableName} failed:`, e.message);
    }
  }

  const totalRecords = Object.values(recordCounts).reduce((s, n) => s + n, 0);
  const durationMs = Date.now() - started;

  const backupData = {
    version:   '1.0',
    timestamp: new Date().toISOString(),
    source:    'supabase',
    tables,
  };
  const sizeBytes = Buffer.byteLength(JSON.stringify(backupData), 'utf8');

  const metadata = {
    recordCounts,
    totalRecords,
    durationMs,
    excluded: ['auth_tokens', 'passwords', 'backups'],
    errors: errors.length > 0 ? errors : undefined,
  };

  try {
    const { error } = await supabase.from('backups').insert({
      id,
      chat_id:    OWNER_CHAT_ID,
      trigger,
      data:       backupData,
      metadata,
      size_bytes: sizeBytes,
    });
    if (error) throw error;

    console.log(`[Backup] ${trigger} backup ${id} completed: ${totalRecords} records, ${sizeBytes} bytes in ${durationMs}ms`);
    return {
      success:     true,
      id,
      size:        sizeBytes,
      recordCount: totalRecords,
      durationMs,
      errors:      errors.length > 0 ? errors : undefined,
    };
  } catch (e) {
    console.warn('[Backup] Insert failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function listBackups(limit = 30) {
  if (!isEnabled()) return [];
  const { data, error } = await supabase
    .from('backups')
    .select('id, trigger, metadata, size_bytes, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[Backup] listBackups error:', error.message);
    return [];
  }
  return data || [];
}

async function getBackup(id) {
  if (!isEnabled()) return null;
  const { data, error } = await supabase
    .from('backups')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn('[Backup] getBackup error:', error.message);
    return null;
  }
  return data;
}

async function cleanupOldBackups() {
  if (!isEnabled()) return { deleted: 0 };
  let totalDeleted = 0;

  // Auto: keep last 30
  const { data: autoBackups } = await supabase
    .from('backups').select('id')
    .eq('trigger', 'auto')
    .order('created_at', { ascending: false });
  if (autoBackups && autoBackups.length > 30) {
    const toDelete = autoBackups.slice(30).map(b => b.id);
    const { error } = await supabase.from('backups').delete().in('id', toDelete);
    if (!error) totalDeleted += toDelete.length;
  }

  // Manual: keep last 10
  const { data: manualBackups } = await supabase
    .from('backups').select('id')
    .eq('trigger', 'manual')
    .order('created_at', { ascending: false });
  if (manualBackups && manualBackups.length > 10) {
    const toDelete = manualBackups.slice(10).map(b => b.id);
    const { error } = await supabase.from('backups').delete().in('id', toDelete);
    if (!error) totalDeleted += toDelete.length;
  }

  if (totalDeleted > 0) {
    console.log(`[Backup] Cleanup: deleted ${totalDeleted} old backups`);
  }
  return { deleted: totalDeleted };
}

module.exports = { performBackup, listBackups, getBackup, cleanupOldBackups };
