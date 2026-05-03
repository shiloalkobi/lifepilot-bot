# Pre-Fix Row Count Snapshot — 2026-04-30

Baseline captured **before** any security migration (RLS still OFF on all 12 tables).

## Source

SQL executed by שילה (the user) via Supabase MCP / SQL Editor against project `zxxcdvveezcjuwijwlab`. Counts pasted into this document on 2026-04-30 as part of Sub-Phase 1.5.1 approval.

## Counts

| Table | Rows | RLS |
|---|---:|---|
| `leads` | 2 | OFF |
| `health_logs` | 2 | OFF |
| `habits` | 2 | OFF |
| `expenses` | 0 | OFF |
| `tasks` | 5 | OFF |
| `passwords` | 0 | OFF |
| `memory` | 1 | OFF |
| `watchlist` | 6 | OFF |
| `auth_tokens` | 0 | OFF |
| `backups` | 8 | OFF |
| `doc_summaries` | 2 | OFF |
| `image_edits` | 1 | OFF |
| **TOTAL** | **29** | **0 / 12** |

## Verification rule

After Phase 3 RLS lockdown completes, re-run the same `COUNT(*)` query for every table. Each post-migration count must satisfy:

```
post >= pre   (per table)
```

A **lower** count on any table = potential data loss → STOP and investigate before proceeding to verification or rollback steps. Higher counts are expected and acceptable (the bot may write rows during the smoke-test window).

## Notes

- `expenses`, `passwords`, `auth_tokens` had 0 rows at baseline — these tables are still in active use (recent commits show writes to expenses + passwords), but they may have been wiped or migrated to JSON fallback at the time of snapshot. Worth a quick mental check at verification time.
- `backups` (8 rows) is the heaviest table. Backups are append-mostly and pruned by `bot/backup.js:158, 169` — verification math should account for the fact that scheduled backup pruning may legitimately reduce row count between snapshots if the migration window crosses a pruning cycle.
- Reference to active call-sites per table: see `docs/security/01b-analyst-findings.md` § 3.
