# CRPS Research Agent — Dev Implementation Log

| Field | Value |
|---|---|
| Author | Amelia — BMAD Dev (💻) |
| Date Started | 2026-05-03 |
| Mode | IMPLEMENTATION — Code + DB changes (gated per sub-phase) |
| Phase | 4 of 6 (analyst → architect → PM → **dev** → QA → docs) |
| Predecessor | `01c-pm-prd-crps.md` (approved by Shilo, Q26–Q28 accepted) |
| Successor (gated) | Phase 5 — `@qa` testing + `01e-qa-test-results.md` |
| Branch | `research/crps-agent-phase1` |
| Sub-phases | 4a (DB) → 4b (sources) → 4c (filter) → 4d (tools) → 4e (registration) → 4f (smoke) |

---

## Sub-phase 4a — DB Migrations ✅ COMPLETE

### Inputs consumed
- DDL specification: `01b §4` (research_articles, research_topics, research_blocked_log, research_user_profile)
- Security model: `docs/security/01f-final-summary.md` Rule 1 (ENABLE+FORCE RLS, zero policies)
- Migration delivery decision: Q16 → Supabase MCP (continuing security/01f pattern; no `supabase/migrations/` dir in repo)

### Execution channel
Supabase MCP via Anthropic web chat session (continues established pattern from `docs/security/01f` §"Database Migration"). **NOT** via the local Claude Code seat — that seat does not have Supabase MCP loaded in this session (verified via ToolSearch). Shilo escalated the gap and approved running through the web chat. This decision is consistent with Q16 (Supabase MCP is the migration channel of record for this project), and the gap is captured under "Lessons / notes for 4b" below so the same path is followed next time DB schema changes are needed.

### Migrations applied
1. **`enable_crps_research_agent`** — 4 tables + helper function + trigger + indices (matches `01b §4` byte-for-byte at the structural level — same column types, constraints, indices, comments)
2. **`fix_set_updated_at_search_path`** — hardening fix in response to Supabase Advisor lint 0011 (`function_search_path_mutable`). Added `SET search_path = public, pg_temp` to `set_updated_at()`.

### Schema delta

```sql
-- Helper function (idempotent — created once; the search_path hardening migration
-- replaces the body via CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;  -- post-hardening (advisor lint 0011 fix)

-- ─── Table 1: research_articles ──────────────────────────────────────────
CREATE TABLE public.research_articles (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source               text          NOT NULL,
  source_id            text          NOT NULL,
  title                text          NOT NULL,
  abstract             text,
  url                  text          NOT NULL,
  authors              text[]        NOT NULL DEFAULT '{}',
  published_at         timestamptz,
  fetched_at           timestamptz   NOT NULL DEFAULT now(),
  tier                 int           NOT NULL,
  framing_he           text,
  classifier_rationale text,
  surfaced_to_chat_id  bigint,
  surfaced_at          timestamptz,
  CONSTRAINT chk_tier   CHECK (tier IN (1, 2)),
  CONSTRAINT chk_source CHECK (source IN ('pubmed', 'clinicaltrials', 'medrxiv')),
  CONSTRAINT uniq_source_article UNIQUE (source, source_id)
);
CREATE INDEX idx_research_articles_chat_recent
  ON public.research_articles (surfaced_to_chat_id, surfaced_at DESC)
  WHERE surfaced_to_chat_id IS NOT NULL;
CREATE INDEX idx_research_articles_source
  ON public.research_articles (source, fetched_at DESC);
CREATE INDEX idx_research_articles_tier
  ON public.research_articles (tier);
ALTER TABLE public.research_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_articles FORCE  ROW LEVEL SECURITY;

-- ─── Table 2: research_topics ────────────────────────────────────────────
CREATE TABLE public.research_topics (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     bigint      NOT NULL,
  topic       text        NOT NULL,
  keywords    text[]      NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  active      boolean     NOT NULL DEFAULT true,
  CONSTRAINT uniq_chat_topic UNIQUE (chat_id, topic)
);
CREATE INDEX idx_research_topics_chat_active
  ON public.research_topics (chat_id, active)
  WHERE active = true;
ALTER TABLE public.research_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_topics FORCE  ROW LEVEL SECURITY;

-- ─── Table 3: research_blocked_log ───────────────────────────────────────
CREATE TABLE public.research_blocked_log (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source               text        NOT NULL,
  source_id            text        NOT NULL,
  title                text        NOT NULL,
  url                  text,
  blocked_at           timestamptz NOT NULL DEFAULT now(),
  blocked_by           text        NOT NULL,
  reason_code          text        NOT NULL,
  classifier_rationale text,
  CONSTRAINT chk_blocked_by CHECK (blocked_by IN ('pre_filter', 'llm_classifier'))
);
CREATE INDEX idx_research_blocked_log_recent
  ON public.research_blocked_log (blocked_at DESC);
CREATE INDEX idx_research_blocked_log_reason
  ON public.research_blocked_log (reason_code);
ALTER TABLE public.research_blocked_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_blocked_log FORCE  ROW LEVEL SECURITY;

-- ─── Table 4: research_user_profile ──────────────────────────────────────
CREATE TABLE public.research_user_profile (
  chat_id              bigint      PRIMARY KEY,
  profile_he           text,
  treatments           text[]      NOT NULL DEFAULT '{}',
  preferences          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_disclaimer_seen timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_user_profile_updated
  ON public.research_user_profile (updated_at DESC);
ALTER TABLE public.research_user_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_user_profile FORCE  ROW LEVEL SECURITY;

CREATE TRIGGER trg_research_user_profile_updated_at
  BEFORE UPDATE ON public.research_user_profile
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
```

`COMMENT ON TABLE` / `COMMENT ON COLUMN` clauses applied verbatim per `01b §4` for each of the four tables (omitted from the abridged view above for brevity — they are present in the live schema).

### Verification — all PASS

| # | Check | Method | Result |
|---|---|---|---|
| V1 | RLS enabled on all 4 new tables | `SELECT relrowsecurity FROM pg_class WHERE relname IN (...)` | 4/4 = `true` ✅ |
| V2 | FORCE RLS enabled on all 4 new tables | `SELECT relforcerowsecurity FROM pg_class WHERE relname IN (...)` | 4/4 = `true` ✅ |
| V3 | Zero policies on all 4 new tables (deny-by-default) | `SELECT count(*) FROM pg_policies WHERE tablename IN (...)` | 0 ✅ |
| V4 | Trigger active on `research_user_profile` | `SELECT * FROM information_schema.triggers WHERE trigger_name = 'trg_research_user_profile_updated_at'` | 1 row, `BEFORE UPDATE`, enabled ✅ |
| V5 | Helper function exists with hardened `search_path` | `\df+ public.set_updated_at` | present, `search_path` = `public, pg_temp` ✅ |
| V6 | Supabase Advisor lint state | dashboard advisor run | 0 ERRORS, 0 WARNINGS, 16 INFOs (all `rls_enabled_no_policy` — **intentional**, per Rule 1) ✅ |
| V7 | 12 pre-existing tables untouched | `list_tables` before/after diff | 12 → 16 (4 added, 0 modified, 0 removed) ✅ |
| V8 | curl test from `01b §4.6` (anon → REST → all 4 tables BLOCKED) | **deferred to Phase 4f smoke testing** | DoD-tracked ⏳ |

> **V8 note — honest gap:** the curl-from-outside RLS verification (anon-side, REST endpoint) wasn't run in 4a. V1+V2+V3 verify the same property *from inside* the DB (pg_class/pg_policies). The external-perspective test adds independent confirmation of REST behaviour and is gated to 4f's smoke pass per the brief acknowledging this as deferred. It's not skipped — it's scheduled.

### DoD §4.1 (Database) — checklist status

- [x] 4 new tables created
- [x] Each table: ENABLE + FORCE RLS, zero policies
- [x] curl test from `01b §4.6` ready (deferred to Phase 4f smoke testing)
- [x] Indices per `01b §4` (3 + 1 + 2 + 1 = **7 indices** total)
- [x] Trigger `trg_research_user_profile_updated_at` active
- [x] Helper function `set_updated_at()` exists with hardened `search_path`

### Additive-Only Verification (post-4a)

- ✅ **0** changes to existing tables (12 untouched, verified via `list_tables` before/after)
- ✅ **0** changes to `bot/*` code (no commit on source files in 4a)
- ✅ **0** changes to scheduler jobs (12 cron jobs continue to fire as before)
- ✅ **0** changes to env vars (`.env.example` untouched in 4a)
- ✅ **0** changes to `bot/supabase.js` (service_role client carried forward)
- ✅ **0** new top-level directories
- ✅ Pre-existing 7 dirty/untracked files: still unstaged at the moment of this commit

### STOP-list re-check (per `01a §8.9`)

| # | Trigger | Activated in 4a? |
|---|---|---|
| 1 | שינוי schema של טבלה קיימת | ❌ no |
| 2 | שינוי mechanism של loader/routing קיים | ❌ no (no code changes in 4a) |
| 3 | שדרוג גרסת `@supabase/supabase-js` | ❌ no |
| 4 | שינוי ב-system prompt הראשי של הבוט | ❌ no |
| 5 | הוספת cron job | ❌ no |
| 6 | שינוי `bot/supabase.js` | ❌ no |
| 7 | שינוי `bot/agent.js` בקטע ה-CORE/EXTENDED | ❌ no (deferred to 4e) |

**None of the 7 STOP triggers activated.** Migration was purely additive.

### Lessons / notes for 4b

1. **Tool channel of record** — Supabase MCP via Anthropic web chat is the migration channel for this project. The local Claude Code seat does not have MCP loaded; future schema changes should default to the same web-chat path to avoid round-trips.
2. **Advisor lint hygiene** — every new SQL function should explicitly `SET search_path` from creation, not as a follow-up fix. Adding to dev mental checklist for Phase 5+ work.
3. **DDL-first commits** — Phase 4a delivered no source code, only DB. The pattern of "DB before code" lets adapter implementation in 4b assume tables exist, simplifying error handling.

### Ready for 4b — prerequisites confirmed

- ✅ 4 tables exist and accept service_role writes
- ✅ Schema matches Winston's `01b §4` design exactly
- ✅ No pre-existing data to migrate (clean slate per design)
- ✅ Trigger active on `research_user_profile`
- ✅ Helper function `set_updated_at()` exists with hardened `search_path`
- ✅ Supabase Advisor: 0 ERRORS, 0 WARNINGS

### Time spent
**~30 minutes** (matches `01c §8` PRD estimate of "30 min").

---

## Sub-phase 4b — Source Adapters ⏳ PENDING

[Section reserved — Amelia will fill in after Phase 4b completes]

**Planned scope:**
- `skills/research/sources/pubmed.js`
- `skills/research/sources/clinicaltrials.js`
- `skills/research/sources/medrxiv.js`
- `skills/research/sources/_adapter.js` (interface checker)
- Unit tests in `tests/fixtures/<adapter>/` with mock HTTP

**Estimated effort:** 4–6 hours (per `01c §8`)

---

## Sub-phase 4c — Hope Filter ⏳ PENDING

[Section reserved — Amelia will fill in after Phase 4c completes]

**Planned scope:**
- `skills/research/filter/keywords.js` (15 approved keywords from Q15)
- `skills/research/filter/classifier.js` (Gemini Flash, prompt per `01b §6.3`)
- `skills/research/filter/tiers.js` (tier rules + framing)
- `skills/research/i18n/glossary-he.js` (mapping per `01a §6.5`)
- 10-fixture pass at ≥ 9/10 accuracy (per `01b §9.3`)

**Estimated effort:** 4–6 hours

---

## Sub-phase 4d — Tool Implementations ⏳ PENDING

[Section reserved — Amelia will fill in after Phase 4d completes]

**Planned scope:**
- `skills/research/index.js` orchestrator
- `skills/research/storage/{articles,topics,profile,blocked-log}.js`
- 4 EXTENDED-tier tools per `01b §5`: `search_research`, `subscribe_research_topic`, `get_research_history`, `set_research_profile`
- Confirmation flow for treatment changes (Q20)
- Israeli trials ranking weight (US09)

**Estimated effort:** 6–8 hours

---

## Sub-phase 4e — Skill Registration ⏳ PENDING

[Section reserved — Amelia will fill in after Phase 4e completes]

**Planned scope:**
- `skills/research/SKILL.md`
- Verify auto-load by `bot/skills-loader.js` (no `bot/*` changes)
- Verify `git diff main -- bot/index.js bot/agent.js bot/telegram.js bot/supabase.js bot/skills-loader.js` is **EMPTY**
- If any `bot/*` file requires changes → **STOP, escalate**

**Estimated effort:** 1–2 hours

---

## Sub-phase 4f — Smoke Testing ⏳ PENDING

[Section reserved — Amelia will fill in after Phase 4f completes]

**Planned scope:**
- RT01–RT06 from `01b §9.7` (research-side smoke tests)
- Sample 5 of T01–T14 from security work (regression check on existing tables)
- Cost projection from 50 simulated calls
- Render startup log shows skill loaded
- Resolve V8 (curl test from outside, per DoD §4.1)

**Estimated effort:** 2–3 hours

**Gate:** ✅ all green = ready to merge `research/crps-agent-phase1` → `main` (subject to Shilo's explicit approval).

---

## Cross-cutting concerns (updated each sub-phase)

### Files modified across all of Phase 4

Running list — Amelia appends each sub-phase:

- **4a:** 0 source files (DB only via Supabase MCP). 1 doc file (`docs/research/01d-dev-implementation.md` = this file).
- **4b:** TBD
- **4c:** TBD
- **4d:** TBD
- **4e:** TBD
- **4f:** TBD

### Pre-existing dirty files audit

At every commit in Phase 4, the following must remain unstaged. **Re-checked at this commit (4a):**

```
M  bot/image-editor.js
M  data/expenses.json
M  data/health-log.json
M  data/tasks.json
?? data/habits.json
?? data/passwords.json
?? data/stock-watchlist.json
```

✅ All 7 verified unstaged at the moment of staging this doc.

### Migration channel of record

Supabase MCP via Anthropic web chat session (project `zxxcdvveezcjuwijwlab`). Documented here so 4b–4f and any future schema work follows the same path.

### STOP-list status (running)

7 triggers from `01a §8.9` — none activated through 4a. Re-checked at every sub-phase commit.

---

— Amelia 💻
