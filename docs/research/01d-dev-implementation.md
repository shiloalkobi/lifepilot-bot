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

## Sub-phase 4b — Source Adapters ✅ COMPLETE

### Inputs consumed
- Adapter contract: `01b §7`
- PubMed search strategy: `01a §2.1` (MeSH + Title/Abstract terms; final query in `pubmed.js` `SEARCH_QUERY`)
- ClinicalTrials.gov v2 conventions: verified online (Task 1) before code; `query.cond` + `query.locn` accepted
- medRxiv API conventions: verified online — **no keyword-search endpoint exists**; client-side filter mandated
- `01c §8` sub-phase 4b inputs/outputs/exit criteria

### Files created (with line counts)

**Source code** (4 files, 453 LOC):

| File | LOC |
|---|---|
| `skills/research/sources/_adapter.js` | 52 |
| `skills/research/sources/pubmed.js` | 174 |
| `skills/research/sources/clinicaltrials.js` | 117 |
| `skills/research/sources/medrxiv.js` | 110 |

**Unit tests** (4 files, 444 LOC):

| File | LOC | Tests |
|---|---|---|
| `tests/research_sources_adapter.test.js` | 50 | 7 |
| `tests/research_sources_pubmed.test.js` | 123 | 15 |
| `tests/research_sources_clinicaltrials.test.js` | 135 | 10 |
| `tests/research_sources_medrxiv.test.js` | 136 | 15 |

**Test fixtures** (live-captured, 6 files, ~398 KB):

- `tests/fixtures/pubmed/einfo.json`, `esearch.json`, `efetch.xml`
- `tests/fixtures/clinicaltrials/search.json`, `israel.json`
- `tests/fixtures/medrxiv/details.json`

### Task 1 — Online verification (per Hard Constraint "honest gaps")

| # | Endpoint | URL | Result |
|---|---|---|---|
| O1 | PubMed einfo | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?db=pubmed&retmode=json` | HTTP 200, JSON; `dbinfo[0].dbname=pubmed`, count=40,489,264 ✅ |
| O2 | PubMed esearch (CRPS MeSH) | `…/esearch.fcgi?term=...[MeSH]&retmode=json` | HTTP 200; 6,220 hits in MeSH ✅ |
| O3 | PubMed efetch (sample PMID) | `…/efetch.fcgi?id=42066272&retmode=xml&rettype=abstract` | HTTP 200; 5,858 bytes XML; `<PubmedArticle>` parsable ✅ |
| O4 | CT.gov v2 (CRPS RECRUITING) | `https://clinicaltrials.gov/api/v2/studies?query.cond=...&filter.overallStatus=RECRUITING` | HTTP 200; first hit NCT05986461 ✅ |
| O5 | CT.gov v2 (Israel filter) | `…/studies?query.cond=...&query.locn=Israel` | HTTP 200; first hit NCT01338129 (Rabin Medical Center, Vitamin C for CRPS Type I) ✅ |
| O6 | medRxiv details | `https://api.medrxiv.org/details/medrxiv/2024-01-01/2024-12-31/0` | HTTP 200; 100 papers/page; total 15,523 in 2024 ✅ |

**Honest gaps discovered during Task 1:**

1. **PubMed `sort=date` rejected.** esearch warninglist returned `Unknown sort schema 'date' ignored`. Removed sort param from production call — PubMed default ordering (by relevance) used; downstream ranking happens in 4d.
2. **medRxiv has no keyword-search endpoint.** API offers only date-range bulk download (`/details/medrxiv/<from>/<to>/<cursor>`, 100 papers/page). Adapter compensates by client-side regex filter (`isCrpsPaper`) over title+abstract+category. CRPS preprints are rare (single digits/year per Mary §1.1) so volume is acceptable.
3. **CT.gov v2 location filter parameter name.** Brief mentioned `filter.country=Israel`; empirically `query.locn=Israel` is the working spelling. Adapter uses the latter.

### Verification table

| # | Test | Method | Result |
|---|---|---|---|
| V9  | `_adapter` contract validation | `node:test`, 7 cases | 7/7 ✅ |
| V10 | `pubmed` parser + orchestration | `node:test`, 15 cases (incl. fixture parse + mocked-fetch flow) | 15/15 ✅ |
| V11 | `clinicaltrials` parser + orchestration | `node:test`, 10 cases (incl. fixture parse + dedup mock) | 10/10 ✅ |
| V12 | `medrxiv` parser + orchestration | `node:test`, 15 cases (incl. CRPS regex + filter mock) | 15/15 ✅ |
| V13 | Live `healthCheck()` — pubmed | real HTTPS | `true` ✅ |
| V14 | Live `healthCheck()` — clinicaltrials | real HTTPS | `true` ✅ |
| V15 | Live `healthCheck()` — medrxiv | real HTTPS | `true` ✅ |
| V16 | Live `pubmed.fetch(null, now-30d)` | real esearch + efetch | **20 articles** returned, all fields populated ✅ |
| V17 | Live `clinicaltrials.fetch(null, null)` | real HTTPS, global + Israel merge | **24 articles** returned (3 Israeli, 1 recruiting) ✅ |
| V18 | Live `medrxiv.fetch(null, now-30d)` | deferred to 4f smoke testing | ⏳ honest gap (slow + likely 0 — preprint volume) |

**Test totals: 47 cases across 4 files. 47/47 PASS.**

> **Two test failures occurred during 4b development and were resolved before staging:**
> 1. `isoDate formats Date as YYYY-MM-DD` failed because `getMonth/getDate` use local timezone (Asia/Jerusalem) — `2026-12-31T23:00:00Z` produced `2027-01-01`. **Fix:** switched `isoDate` to UTC functions (`getUTC*`). Deterministic across timezones, matches medRxiv API expectations.
> 2. `isCrpsPaper rejects unrelated papers` failed because the test's negative-case abstract literally contained the string "CRPS" — the regex correctly matched. **Fix:** corrected the test fixture (code was right).

### DoD §4.2 (Source Adapters) — checklist status

- [x] `skills/research/sources/_adapter.js` (interface checker) — `assertAdapter()` runs at each adapter's module load; bad shape = require-time error
- [x] `skills/research/sources/pubmed.js` implements adapter contract; tested via fixture + mocked fetch + live
- [x] `skills/research/sources/clinicaltrials.js` implements contract; supports Israel filter via `query.locn`; dedups global + Israel queries
- [x] `skills/research/sources/medrxiv.js` implements contract; client-side keyword filter (`isCrpsPaper`)
- [x] Unit tests with mock HTTP — **47/47 PASS**, no live network in committed tests
- [x] Live `healthCheck()` — **3/3 return `true`** (V13–V15)
- [x] PubMed live fetch returns ≥1 article — **20 articles** ✅ (well above ≥1 floor; CRPS is well-published)
- [x] Rate limit honored at adapter level (declared via `rateLimit` property; throttling/queueing scheduled for 4d when storage layer needs it)

### Additive-Only Verification (post-4b)

- ✅ **0** changes to existing tables (DB unchanged since 4a)
- ✅ **0** changes to `bot/*` code (verified: `git diff main..HEAD -- bot/` = 0 lines; `git diff --cached -- bot/` = 0 lines)
- ✅ **0** changes to scheduler jobs
- ✅ **0** changes to `.env.example` (NCBI_API_KEY only read from `process.env` — optional; documentation deferred to 4e per brief)
- ✅ **0** changes to `bot/supabase.js`
- ✅ **0** changes to `bot/agent.js`
- ✅ **0** changes to `bot/skills-loader.js`
- ✅ **0** changes to `bot/telegram.js`
- ✅ **0** changes to `package.json` (used built-in `node:test` + global `fetch` — no new dependency)
- ✅ Pre-existing 7 dirty/untracked files: still unstaged at the moment of this commit

**One scope addition documented for transparency:** `tests/` is a new top-level directory. `01b §12.6` projected 0 new top-level dirs ("הכל ב-`skills/research/` תחת קיים"). The addition was explicitly requested by Shilo's Phase 4b brief ("`tests/fixtures/<adapter>/`", "`git add tests/fixtures/`") and is purely additive (zero impact on existing files). Not a STOP-list trigger — sanctioned by the user.

### STOP-list re-check (per `01a §8.9`)

| # | Trigger | Activated in 4b? |
|---|---|---|
| 1 | שינוי schema של טבלה קיימת | ❌ no |
| 2 | שינוי mechanism של loader/routing קיים | ❌ no (no `bot/*` changes) |
| 3 | שדרוג גרסת `@supabase/supabase-js` | ❌ no |
| 4 | שינוי ב-system prompt הראשי של הבוט | ❌ no |
| 5 | הוספת cron job | ❌ no |
| 6 | שינוי `bot/supabase.js` | ❌ no |
| 7 | שינוי `bot/agent.js` בקטע ה-CORE/EXTENDED | ❌ no |

**0/7 triggers activated.** New `tests/` directory is sanctioned scope addition (above), not a trigger.

### Lessons / notes for 4c

1. **Dedup happens at storage layer, not filter.** UNIQUE `(source, source_id)` on `research_articles` (4a) gives free dedup. The 4c classifier should not be gated on this — it can wastefully classify the same article twice if the orchestrator (4d) doesn't pre-check storage. Plan 4d: query storage by source_id before LLM call.
2. **medRxiv adapter pre-filters to CRPS at adapter level.** This means by the time articles reach the 4c hope filter, they're already topic-relevant. Hope filter still needs to run for tier classification (Tier 1/2 vs blocked Tier 3).
3. **Mock-fetch test pattern is now established.** All 4 source adapter test files use the same `globalThis.fetch` swap-and-restore pattern. Reuse for 4c (Gemini classifier mock) and 4d (DB mock or real).
4. **CT.gov v2 dedups via local Set.** First implementation called global API + Israel API and merged. Local Set on `nctId` ensures no duplicate articles even when both queries return the same study.
5. **PubMed XML parsing is regex-based, not full XML parser.** Acceptable for the documented PubMed DTD because the elements we extract (PMID, ArticleTitle, AbstractText, Author, PubDate) have stable, unambiguous tag structures. If 4c/4d need additional fields (e.g., MeSH terms, journal name), extend `parseEfetchXml`. If volume of edge-cases grows, consider adding `fast-xml-parser` (would be a deliberate dependency addition — not done in 4b).

### Ready for 4c — prerequisites confirmed

- ✅ 3 adapters return Article-shaped objects matching the DDL fields
- ✅ Live verification: PubMed 20 articles, CT.gov 24 (3 Israeli, 1 recruiting)
- ✅ Adapter contract enforced at module load — bad shapes fail at `require` time
- ✅ Mock-fetch test pattern established for downstream phases
- ✅ Test infrastructure (`node:test`) confirmed working — no new deps needed
- ✅ Live fetched articles include realistic field shapes for 4c hope filter to consume

### Time spent

**~3 hours** (within `01c §8` PRD estimate of "4–6 hours" — under the upper bound).

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
- **4b:** 8 source files (4 adapters + 4 test files = 897 LOC) + 6 fixture files + this doc updated. **Net new top-level dir: `tests/`** (sanctioned by Shilo's 4b brief).
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
