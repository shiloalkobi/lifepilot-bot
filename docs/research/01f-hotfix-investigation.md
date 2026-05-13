# 01f — Hotfix Investigation (Phase 4f.4)

**Author:** Amelia
**Date:** 2026-05-11
**Mode:** INVESTIGATION (read-only — no code edits in Task 1)
**Branch:** `hotfix/4f4-slash-dates-pubmed-quality` (off main `bda01c1`)
**Trigger:** Shilo's second post-deploy smoke (after the 4f.3 hotfix cycle merged at `b858401`/`bda01c1`) surfaced 3 new production issues.

> **Status:** **ALL 3 ISSUES ✅ RESOLVED.** Issue #2 in Commit A (2026-05-11); Issue #3 in Commit B (2026-05-11); Issue #1 in Commit C (2026-05-11). Branch ready for `--no-ff` merge to main per Shilo's approval.

---

## §1 — Issue #1: `/research` slash command silently no-op

### ✅ STATUS: RESOLVED in Commit C (2026-05-11)

`/research` slash handler at `bot/telegram.js:582` updated with three surgical changes per 4f.4 §1 / Q1 approval (minimal-surface within authorized scope):

1. Regex widened to `^/research(?:@\w+)?(?:\s+.*)?$` (accepts `@botname` suffix, trailing whitespace, and ignored args per Q4).
2. JSON.parse added with `typeof` guard: `const result = typeof raw === 'string' ? JSON.parse(raw) : raw;` — fixes the primary regression introduced by 4f.3 Commit B (`6d1d4a4`) when `execute()` migrated from object to JSON-string return.
3. Entry log added: `console.log('[/research] invoked by chat', msg.chat.id);` so future regressions are observable in Render logs.

Tests: 205 prior + 1 contract-guard = **206/206 PASS**. STOP-list: 0/7 (single-handler edit, Q1-authorized). Live verification deferred to Shilo's post-merge RT01 retest.

The original investigation below is preserved for the audit trail.

---

### Symptom (from Shilo's smoke + Render logs)

User types `/research` → no Render log entry appears, no useful Telegram response. Free-text path (`מחקר חדש על CRPS` → agent → `search_research`) works correctly.

### Code excerpts

**The `/research` handler at `bot/telegram.js:582-603`** (added in Phase 4e.5):

```js
bot.onText(/^\/research$/, async (msg) => {
  try {
    const research = require('../skills/research');
    const result = await research.execute('search_research', {}, { chat_id: msg.chat.id });
    if (!result.ok) {
      return bot.sendMessage(msg.chat.id, `⚠️ ${result.error || 'שגיאה במחקר.'}`);
    }
    const header = `🔬 <b>מחקר CRPS</b> (${result.articles.length} מאמרים…)`;
    // …builds body from result.articles…
  } catch (err) {
    console.error('[/research]', err.message);
    bot.sendMessage(msg.chat.id, '⚠️ שגיאה במחקר.');
  }
});
```

**The `bot.on('message')` guard at `bot/telegram.js:1096`** (referred to in Shilo's hint as "the generic slash interceptor around 1072"):

```js
if (!msg.text || msg.text.startsWith('/')) return;
```

### Dispatch order analysis (corrects the hint)

`node-telegram-bot-api` exposes **two parallel listener families**:
- `bot.onText(regex, cb)` — fires when text matches the regex.
- `bot.on('message', cb)` — fires on every message event.

They are **independent EventEmitter handlers**, not chained. A `return` inside one does **not** prevent the other from firing.

So the line-1096 guard is not actually intercepting `/research` from the `onText` registration. It only short-circuits the `bot.on('message')` body for slash commands — preventing slash commands from being routed to the agent path. `onText` handlers still fire.

### Real root cause (two intertwined defects, both introduced by earlier phases)

**Defect A (PRIMARY) — `/research` handler not updated for 4f.3 Commit B's contract change.**

In 4f.3 Commit B (`6d1d4a4`), `execute()` was changed to return `JSON.stringify(result)` instead of a plain object — to fix the `"[object Object]"` hallucination bug (Bug 4). The agent path in `bot/agent.js` already consumes strings correctly. **But the `/research` slash handler at `bot/telegram.js:585` was never updated** — it still treats `result` as an object:

```js
const result = await research.execute('search_research', {}, { chat_id: msg.chat.id });
if (!result.ok) {                              // ← string has no `.ok` → undefined
  return bot.sendMessage(msg.chat.id, `⚠️ ${result.error || 'שגיאה במחקר.'}`);
}
```

`result.ok` on a string is `undefined`, `!undefined === true`, so the handler **always** short-circuits into the error branch and sends `⚠️ שגיאה במחקר.` regardless of whether the underlying call succeeded.

This **fully explains the symptom**:
- Handler fires (regex matches) → no console log because there's no entry log
- Falls into the `!result.ok` branch → `sendMessage` (no console.error)
- User sees `⚠️ שגיאה במחקר.` and may have read it as "silently broken"

**Defect B (SECONDARY) — regex `/^\/research$/` is over-strict.**

The regex matches *only* the exact string `/research`. Edge cases that break it:
- `/research ` (trailing whitespace from mobile keyboards) → no match
- `/research@LifePilotBot` (group-style suffix; rare in 1-on-1 but possible) → no match
- `/Research` (capitalised) → no match

Compare with `bot.onText(/\/dashboard/)` at `bot/telegram.js:579` — unanchored, matches generously. The asymmetry is a footgun.

### Proposed fix (Issue #1)

**Scope:** ALLOWED under Q1 approval — adding entry log + result parsing in the handler is *not* rewriting the interceptor and is *not* changing how slash dispatch works globally.

**File:** `bot/telegram.js:582-603`
**Type:** Local handler edit (~6 lines)

```js
bot.onText(/^\/research(?:@\w+)?\s*$/, async (msg) => {
  console.log('[/research] invoked by chat', msg.chat.id);
  try {
    const research = require('../skills/research');
    const raw = await research.execute('search_research', {}, { chat_id: msg.chat.id });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.ok) {
      return bot.sendMessage(msg.chat.id, `⚠️ ${result.error || 'שגיאה במחקר.'}`);
    }
    // …rest unchanged…
  } catch (err) {
    console.error('[/research]', err.message);
    bot.sendMessage(msg.chat.id, '⚠️ שגיאה במחקר.');
  }
});
```

Two surgical changes:
1. **Regex widened** to `/^\/research(?:@\w+)?\s*$/` — accepts `@botname` suffix and trailing whitespace; still rejects garbage like `/research foo`.
2. **Result parsed** from JSON string (with `typeof` guard so a hypothetical future contract reversion to objects still works).
3. **Entry log** added so future regressions are visible in Render logs.

### Risk assessment

- **Other slash commands:** none affected. This handler is the only one consuming a skill's `execute()` return value.
- **Free-text agent path:** untouched. The agent at `bot/agent.js:2186` already handles strings.
- **STOP-list:** trigger #2 ("change to existing loader/routing mechanism") — **NOT activated**: this is a single-handler edit, not a routing-mechanism change. Q1 explicitly authorized this scope.

---

## §2 — Issue #2: ClinicalTrials.gov partial dates crash `upsertArticle`

### ✅ STATUS: RESOLVED in Commit A (2026-05-11)

`normalizeStartDate(raw)` added in `skills/research/sources/clinicaltrials.js` (handles ISO / `YYYY-MM-DD` / `YYYY-MM` / `YYYY`; returns null for unparseable input). `parseStudy` line ~52 now feeds the helper. `fetchImpl` filters articles whose date can't be normalized with `console.warn('[research] clinicaltrials/<NCT> skipped: missing publication date')` per Q2. Tests: 190 prior + 7 new (5 normalize cases + 1 NCT01338129 fixture + 1 fetchImpl skip case) = **197/197 PASS**. Backfill: not required — natural 6h cache refresh re-inserts the 6 previously-failing trials, including Rabin's vitamin-C CRPS (NCT01338129).

The original investigation below is preserved for the audit trail.

---

### Symptom (from Render logs)

```
[research] upsertArticle failed for clinicaltrials/NCT01338129:
  invalid input syntax for type timestamp with time zone: "2011-04"
```

Six trials currently fail to save, including the most important one for Shilo:

| NCT | Trial |
|---|---|
| NCT01338129 | **Rabin Medical Center — vitamin C for CRPS** (Israel 🇮🇱) |
| NCT02402530 | (CRPS trial) |
| NCT00538850 | (CRPS trial) |
| NCT00580294 | (CRPS trial) |
| NCT00109772 | (CRPS trial) |
| NCT00815932 | (CRPS trial) |

### Root cause — confirmed

**`skills/research/sources/clinicaltrials.js:43`** in `parseStudy`:

```js
published_at: sm.startDateStruct?.date || null,
```

The ClinicalTrials.gov API v2 returns `startDateStruct.date` in **three formats** depending on data completeness:
- Full: `"2015-04-15"` (year-month-day)
- Partial: `"2015-04"` (year-month only, day unknown)
- Year-only: `"2015"` (rare, but observed in older studies)

The DB column `research_articles.published_at` is `timestamptz` (PostgreSQL `timestamp with time zone`). PostgreSQL rejects partial formats with error 22007 `invalid input syntax for type timestamp with time zone` — the error Shilo sees.

### Fix design (per Q2 approval)

**Normalization function** placed inside `clinicaltrials.js` (data-shape concerns belong with the adapter):

```js
function normalizeStartDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw))      return raw;                       // already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw))      return `${raw}T00:00:00Z`;        // YYYY-MM-DD
  if (/^\d{4}-\d{2}$/.test(raw))            return `${raw}-01T00:00:00Z`;     // YYYY-MM → 1st
  if (/^\d{4}$/.test(raw))                  return `${raw}-01-01T00:00:00Z`;  // YYYY → Jan 1st
  return null;                                                                // unrecognised
}
```

**Skip-on-null policy (per Q2):** filter applied in `fetchImpl` *before* the adapter returns, so the article never reaches classification (saves a Hope Filter LLM call per skipped article):

```js
for (const s of studies) {
  const a = parseStudy(s);
  if (!a) continue;
  if (!a.published_at) {
    console.warn(`[research] clinicaltrials/${a.source_id} skipped: missing publication date`);
    continue;
  }
  if (seen.has(a.source_id)) continue;
  seen.add(a.source_id);
  out.push(a);
}
```

Note: placeholder dates like `"2099-01-01"` (e.g., NCT05945147 — "study not yet started") **stay as-is** per Q2 approval. They normalize cleanly to `"2099-01-01T00:00:00Z"` and represent honest API data.

### Backfill of the 6 failed trials

**No manual backfill needed.** The 6 trials weren't inserted because of the upsert error; they're simply absent from the DB. After the fix deploys, the next /research call (or the 6h cache refresh) will re-fetch them, normalize dates, and insert them successfully. The Israel-scoped CT.gov query in `fetchImpl` (line 65-69) guarantees NCT01338129 (Rabin) surfaces.

### Acceptance test (per Hard Constraint #7)

Add to `tests/research_sources_clinicaltrials.test.js`:
- Unit: `normalizeStartDate` handles all 5 formats (ISO, YYYY-MM-DD, YYYY-MM, YYYY, garbage).
- Integration-shaped: a fixture mimicking NCT01338129's API response (with `startDateStruct.date: "2011-04"`) → `parseStudy` returns an article with `published_at: "2011-04-01T00:00:00Z"`.
- Skip-on-null: a fixture with `startDateStruct.date: null` → `fetchImpl` filters it out (warn logged).

---

## §3 — Issue #3: PubMed returns irrelevant articles

### ✅ STATUS: RESOLVED in Commit B (2026-05-11)

`SEARCH_QUERY` in `skills/research/sources/pubmed.js` updated to remove the bare `"RSD"[Title/Abstract]` clause (the false-positive engine — RSD matches "Relative Standard Deviation" in chemistry abstracts) and add the spelled-out `"complex regional pain syndrome"[Title/Abstract]` phrase. Added `isCrpsRelevant(article)` post-filter applied in `fetchImpl` after `parseEfetchXml`. Articles failing the whitelist (`CRPS | complex regional pain | causalgia | reflex sympathetic dystrophy | \bRSD\b`) are rejected at adapter level with `console.warn`. Per Q3 moderate strictness — title OR abstract must match. Tests: 197 prior + 8 new = **205/205 PASS**. Existing DB rows cleaned up by separate SQL via Supabase MCP (per Q5).

The original investigation below is preserved for the audit trail.

---

### Symptom (from Render logs)

Recent /research calls returned articles like:
- *"Size-dependent AIENPs… Staphylococcus aureus"* (bacterial detection)
- *"Fe-MOF… α-lipomycin"* (chemistry)
- *"Carbon dots for Fe(III)"* (chemistry)
- *"Goji berry spermidines"* (food chemistry)

Hope Filter tagged them Tier 1 because the classifier evaluates **emotional safety**, not topical **relevance** — and emotionally-safe-chemistry-paper is, accurately, emotionally safe. Relevance is the adapter's job, and the adapter currently does no relevance filtering.

### Current SEARCH_QUERY at `skills/research/sources/pubmed.js:8-13`

```js
const SEARCH_QUERY =
  '"Complex Regional Pain Syndromes"[MeSH] OR ' +
  '"CRPS"[Title/Abstract] OR ' +
  '"RSD"[Title/Abstract] OR ' +
  '"causalgia"[Title/Abstract] OR ' +
  '"reflex sympathetic dystrophy"[Title/Abstract]';
```

### Root cause analysis — two defects

**Defect A — `"RSD"[Title/Abstract]` is the false-positive engine.**

`RSD` is a heavily-overloaded acronym in biomedical literature:
- Real-time spectroscopic detection
- Relative standard deviation (a *statistics* term used in every analytical chemistry paper)
- Rapid screening device
- Reflex sympathetic dystrophy (our intended meaning, but the rarest of the four)

Most of the irrelevant returns trace to chemistry papers reporting RSD% in their analytical methods sections — which lives in the abstract. PubMed matches on `"RSD"[Title/Abstract]` and returns them as 100% valid hits for the query.

**Defect B — no post-fetch relevance check.**

`parseEfetchXml` at line 90 builds articles and `fetchImpl` returns them straight to the orchestration layer. The Hope Filter classifier (relevance-blind by design) is the next stop. Once the classifier marks them Tier 1, they reach the user.

### Fix design (per Q3 approval — moderate strictness)

**Two-layer defense:**

**Layer 1 — tighten the query.** Drop the bare `"RSD"[Title/Abstract]` clause; use the MeSH form only, which PubMed knows to map exclusively to the CRPS sense:

```js
const SEARCH_QUERY =
  '"Complex Regional Pain Syndromes"[MeSH] OR ' +
  '"complex regional pain syndrome"[Title/Abstract] OR ' +
  '"CRPS"[Title/Abstract] OR ' +
  '"causalgia"[Title/Abstract] OR ' +
  '"reflex sympathetic dystrophy"[Title/Abstract]';
```

(Removed `"RSD"[Title/Abstract]`; added the singular phrase `"complex regional pain syndrome"[Title/Abstract]` so papers that only spell it out and don't use the acronym still hit.)

**Layer 2 — post-fetch relevance filter.** Reject articles whose title *and* abstract both fail a whitelist match, before they reach classification:

```js
const CRPS_RELEVANCE_RE =
  /(CRPS|complex regional pain|causalgia|reflex sympathetic dystrophy|\bRSD\b)/i;

function isCrpsRelevant(article) {
  const haystack = `${article.title || ''}\n${article.abstract || ''}`;
  return CRPS_RELEVANCE_RE.test(haystack);
}
```

Apply in `fetchImpl` after `parseEfetchXml`:

```js
const parsed = parseEfetchXml(xml);
const relevant = parsed.filter(a => {
  if (isCrpsRelevant(a)) return true;
  console.warn(`[research] pubmed/${a.source_id} dropped: not CRPS-relevant`);
  return false;
});
return relevant;
```

**Reject vs Tier-3 downgrade:** **REJECT** at adapter level. Reasoning:
- Tier-3 logging exists for "emotionally unsafe but topically valid" articles. An off-topic chemistry paper is not "blocked content"; it's a search-result false positive. Logging it as blocked muddies the audit trail in `research_blocked_log`.
- Adapter-level rejection is cheaper (no LLM call) and clearer in intent.

`\bRSD\b` uses word boundaries so `RSDA` etc. won't false-match; the bare-acronym sense survives only when it stands alone, which is how the CRPS literature uses it.

### Cleanup of existing irrelevant articles in DB

**Optional, low priority.** Articles age out of the 6h `findFreshUnseen` window naturally. A single SQL `DELETE FROM research_articles WHERE source='pubmed' AND title !~* '(CRPS|complex regional pain|causalgia|reflex sympathetic dystrophy)'` would purge them immediately, but this is scope-creep for the hotfix. **Recommendation: skip in 4f.4; revisit only if Shilo sees stale irrelevant articles after deploy.**

### Acceptance test (per Hard Constraint #5)

Add to `tests/research_sources_pubmed.test.js`:
- Unit: `isCrpsRelevant` returns true for {CRPS in title, complex regional pain in abstract, causalgia in title, RSD as standalone word} and false for {chemistry paper with RSDA% in abstract, food paper with no relevant term}.
- Integration-shaped: a fixture XML with two articles (one CRPS, one chemistry-RSD) → `fetchImpl` returns only the CRPS one; the chemistry article is logged as dropped.

---

## §4 — STOP-list re-evaluation

| # | Trigger | Activated by 4f.4 (planned)? | Reasoning |
|---|---|---|---|
| 1 | Schema change to existing table | ❌ no | All fixes are application-level |
| 2 | Change to existing loader/routing mechanism | ❌ no | Issue #1 fix edits ONE handler's body, not the dispatch contract. Q1 explicitly authorized this scope. |
| 3 | `@supabase/supabase-js` upgrade | ❌ no | dep unchanged |
| 4 | Bot main system prompt change | ❌ no | unchanged |
| 5 | Cron job addition | ❌ no | none |
| 6 | `bot/supabase.js` change | ❌ no | unchanged |
| 7 | `bot/agent.js` CORE/EXTENDED change | ❌ no | unchanged |

**0/7 STOP-list triggers expected.** Issue #1 is the only one that touches `bot/*`, and the scope is the single `/research` handler (~6 LOC) — explicitly inside Q1's "minimal-surface" authorization. If during implementation the scope creeps past this, **STOP and escalate** before any commit.

---

## §5 — Proposed fix plan and commit ordering

Three sequential commits on `hotfix/4f4-slash-dates-pubmed-quality`, smallest-first:

| Commit | Issue | Files modified | LOC | Test additions |
|---|---|---|---|---|
| **A** | #2 (dates) | `skills/research/sources/clinicaltrials.js` | ~15 (normalize fn + filter + comments) | `tests/research_sources_clinicaltrials.test.js` — 3+ new cases (formats, NCT01338129, skip-on-null) |
| **B** | #3 (PubMed quality) | `skills/research/sources/pubmed.js` | ~12 (SEARCH_QUERY edit + isCrpsRelevant + filter) | `tests/research_sources_pubmed.test.js` — 2+ new cases (relevance fn, fetchImpl filtering) |
| **C** | #1 (slash command) | `bot/telegram.js` | ~6 (regex + entry log + JSON.parse + typeof guard) | Manual smoke (existing /research handler has no unit test infra; adding one would require Telegram mock — scope-creep) |

### Why this order

1. **Commit A first (dates):** smallest, lowest-risk, recovers the most-important Israeli trial (NCT01338129). Pure data-shape fix.
2. **Commit B second (PubMed):** cleans up the next-most-visible quality issue. Adapter-only.
3. **Commit C last (slash):** only `bot/*` change. By landing it last, if anything in A/B turns out to require unexpected scope, we discover it before touching `bot/*`. Also: Commit C's correctness is *partly* validated by A/B (the parsed `result.articles` it now reads is cleaner after A/B).

### Cumulative test posture

- Existing test count: **190** (185 from pre-4f.3 + 5 chat_id regression tests from 4f.3 Commit B)
- 4f.4 adds: ~5 new test cases (3 for dates, 2 for relevance)
- Expected post-4f.4: **~195/195 PASS**, zero regression
- Each commit must individually keep tests green before the next commit lands

### `bot/*` impact

- Pre-4f.4: `bot/telegram.js` is at `4f.M` state (+24 from 4e.5) + `bot/backup.js` (+1), all other `bot/*` files = main pre-merge
- After 4f.4: only `bot/telegram.js` adds ~6 more LOC for the `/research` handler. All other `bot/*` files unchanged. Total `bot/*` delta vs original main: still localized to telegram.js + backup.js.

---

## §6 — Honest gaps: why didn't 4f.2 or 4f.3 catch these?

### Issue #1 (slash silently broken) — introduced BY 4f.3

This is a **regression from Commit B (`6d1d4a4`)** of phase 4f.3. When `execute()` changed its return contract from object to JSON string (to fix Bug 4 hallucination), the agent path was correctly migrated but the `/research` slash handler at `bot/telegram.js:585` was not. The handler still treats the return as `result.ok`.

**Why 4f.3 missed it:** Commit B's regression tests (`tests/research_chat_id_resolution.test.js`) verify the *skill's* contract — that `execute()` returns a string. They don't verify *consumers* of that string. The /research slash handler had no test exercising the post-execute parsing path. Unit tests pass; integration breaks at the next layer.

**Lesson:** When a public API contract changes, audit all known callers, not just the one that motivated the change. Even better: keep a `git grep` checklist of consumers visible during contract migrations.

### Issue #2 (partial dates) — pre-existed since Phase 4d; surfaced only in production

The `parseStudy` function shipped in Phase 4d with the assumption that `startDateStruct.date` is always ISO. Unit tests in `tests/research_sources_clinicaltrials.test.js` use fixtures with full ISO dates — the partial-date format (`"YYYY-MM"`, `"YYYY"`) was never tested because the fixtures were hand-authored from "good" examples.

**Why 4f.2/4f.3 didn't catch it:** 4f.3 was scoped narrowly to the 3 bugs Shilo reported. 4f.2 smoke is exploratory by design — it found Bug 1 (GRANT) and Bug 2 (chat_id) but did not specifically exercise CT.gov articles with partial dates. Issue #2 is the first 4f-cycle bug whose root cause was *latent since 4d* rather than introduced by the merge.

**Lesson:** Real-world API responses include data shapes that hand-authored fixtures rarely capture. Adding a periodic "sample a real /search response, replay through parseStudy" smoke check (even quarterly) would have caught this. Adopting **property-based testing** for date normalization (try the regex against random strings) would also catch this class of bug.

### Issue #3 (irrelevant PubMed) — pre-existed since Phase 4b; surfaced only when corpus diversified

`SEARCH_QUERY` shipped in Phase 4b. The `"RSD"[Title/Abstract]` clause was always a false-positive magnet, but during 4b's manual smoke (with NCBI's API returning a small CRPS-dense corpus), the false positives rate was below the noise floor.

In production with broader query terms — and especially with the recent ~90-day window catching unrelated chemistry papers — the false positives became visible.

**Why unit tests didn't catch it:** Pubmed unit tests mock `parseEfetchXml` with CRPS-relevant fixtures. The tests verify *parsing*, not *relevance*. There is no test that says "given a fetched corpus of mixed-topic XML, only CRPS-related articles emerge."

**Lesson:** Adapters should validate domain relevance, not just structural correctness. The Hope Filter is a downstream emotional-safety check, not a topic gate. Each adapter is responsible for its own domain fit — same principle as a typed function checking its inputs.

### Cross-cutting meta-lesson for 4f.4 and beyond

Each of the three 4f.4 issues belongs to a different class:

| Issue | Class | Root cause time-of-introduction | Detection delay |
|---|---|---|---|
| #1 (slash) | Contract regression | Phase 4f.3 (last week) | 1 deploy cycle |
| #2 (dates) | Latent edge-case in API consumer | Phase 4d (multiple weeks ago) | Cumulative — finally surfaced in production traffic |
| #3 (PubMed) | Latent query-quality defect | Phase 4b (initial adapter) | Cumulative — surfaced once corpus diversified |

A future BMAD "live-fixture smoke" sub-phase (capture one real API response from each adapter, replay through parsing) would have caught Issue #2 and Issue #3 *before* the user encountered them. Worth proposing as a permanent addition to the BMAD pipeline.

---

## §7 — Open clarifying questions for Shilo (max 3 per Hard Constraint)

1. **Q4 (Issue #1 regex):** is `^/research(?:@\w+)?\s*$` strict-enough / lenient-enough, or do you want `/research foo` (with args) to also dispatch (and ignore the args)?
2. **Q5 (Issue #3 cleanup):** should Commit B include a one-shot SQL `DELETE` to purge already-saved irrelevant pubmed articles, or wait for natural cache aging? Default lean: skip the cleanup; the 6h cache window evicts them within a day.
3. **Q6 (Test additions for Issue #1):** is "manual smoke only" acceptable for Commit C, or do you want a minimal regression test even if it requires standing up a Telegram mock? Default lean: manual smoke is enough for a 6-LOC handler edit; full Telegram-mock infra is scope-creep.

---

## §8 — Pre-fix-plan checklist (state of branch after Task 1)

- [x] Branch `hotfix/4f4-slash-dates-pubmed-quality` created off main `bda01c1`
- [x] No source file edits in Task 1
- [x] No `bot/*` edits in Task 1 (only reads)
- [x] Investigation doc lives at `docs/research/01f-hotfix-investigation.md`
- [ ] Investigation doc committed (pending — this commit)
- [ ] Investigation doc pushed (pending — this commit's push)
- [ ] Shilo approves fix plan §5 + answers Q4/Q5/Q6 (pending Telegram report)

---

— Amelia 💻
