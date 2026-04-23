# Restoring from a Backup

Backups are stored as rows in the Supabase `backups` table. Each row has:

| Column | Notes |
|---|---|
| `id` | `bkp_auto_YYYY-MM-DD` or `bkp_manual_YYYY-MM-DDTHH-MM-SS` |
| `chat_id` | Owner chat id |
| `trigger` | `auto` \| `manual` |
| `data` | `{ version, timestamp, source, tables: { <table>: [rows…] } }` |
| `metadata` | `{ recordCounts, totalRecords, durationMs, excluded, errors? }` |
| `size_bytes` | Buffer size of JSON-serialized `data` |
| `created_at` | Insertion time |

Tables captured: `tasks`, `habits`, `health_logs`, `expenses`, `leads`, `memory`, `watchlist`.
Tables **excluded by design**: `auth_tokens`, `passwords` (plaintext never backed up), `backups` itself.

---

## 1. Pick the backup

Dashboard → 💾 גיבויים → identify the row by id/date, download the JSON to inspect, or query Supabase directly:

```sql
-- List the 10 most recent
SELECT id, trigger, size_bytes, metadata->>'totalRecords' AS records, created_at
FROM backups
ORDER BY created_at DESC
LIMIT 10;
```

## 2. Preview what's inside before restoring

```sql
-- Record counts per table inside one backup
SELECT
  jsonb_object_keys(data->'tables') AS table_name,
  jsonb_array_length(data->'tables'->jsonb_object_keys(data->'tables')) AS row_count
FROM backups
WHERE id = 'bkp_auto_2026-04-23';
```

## 3. Restore a single table

**Everything below assumes a fresh SQL editor session in Supabase. Read each step before running it.** Restoring overwrites current data — always take a fresh backup first.

### 3a. Safety first — snapshot the current state

```sql
-- Replace :table with the table name you're about to restore
CREATE TABLE IF NOT EXISTS _restore_safety_snapshot AS
SELECT * FROM tasks;   -- change 'tasks' to the target table
```

### 3b. Wipe the target table (scoped to owner chat id)

```sql
DELETE FROM tasks WHERE chat_id = :owner_chat_id;
```

### 3c. Insert rows from the backup

The `data->'tables'->'<table>'` value is a JSONB array of full rows. Each row already has the columns the table expects (`id`, `chat_id`, `data`, `created_at`, `updated_at`).

```sql
INSERT INTO tasks (id, chat_id, data, created_at, updated_at)
SELECT
  (row->>'id')::text,
  (row->>'chat_id')::bigint,
  row->'data',
  (row->>'created_at')::timestamptz,
  (row->>'updated_at')::timestamptz
FROM backups,
     jsonb_array_elements(data->'tables'->'tasks') AS row
WHERE backups.id = 'bkp_auto_2026-04-23';
```

Repeat for each table you want to restore — change `tasks` to `habits`, `health_logs`, `expenses`, `leads`, `memory`, `watchlist` as needed. `health_logs` uses `bigint` ids; all others use text ids.

### 3d. Verify

```sql
SELECT COUNT(*) FROM tasks WHERE chat_id = :owner_chat_id;
```

Compare against `metadata->'recordCounts'->>'tasks'` from the backup row.

### 3e. Drop the safety snapshot once you're satisfied

```sql
DROP TABLE _restore_safety_snapshot;
```

---

## Notes / known limitations

- Restore is manual by design — no UI button. The blast radius of a bad restore is huge, so it stays in SQL land.
- `auth_tokens` and `passwords` are **never** backed up. If you lose those, regenerate from the owner session / re-add passwords.
- `backups` itself is excluded — backups don't recurse.
- If `metadata.errors` is non-empty, at least one table failed to snapshot. Check the listed tables before relying on the backup.
