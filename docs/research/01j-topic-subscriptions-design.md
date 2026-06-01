# CRPS-11 — Topic Subscriptions (Design)

Status: DESIGN ONLY — awaiting Shilo's answers to §6 before any code.
Author: Winston (Architect). Date: 2026-06-01.

## Goal (one line)

Let Shilo subscribe to CRPS research topics so the Sunday weekly digest
PRIORITIZES articles whose `title` (English) OR `framing_he` (Hebrew) contains
a subscribed topic's keyword. "Finish the last mile": schema + storage +
write-tool already exist; this builds the read → boost → surface half.

## What already exists (verified against code, 2026-06-01)

- Storage CRUD `skills/research/storage/topics.js` — REAL and tested:
  `upsertTopic` (lines 19-35), `getActiveByChatId` (37-47), `deactivate`
  (49-57), `deleteByChatIdAndTopicPrefix` (59-68). 7 tests in
  `tests/research_storage_topics.test.js`.
- Write tool `subscribe_research_topic` — REAL: registered
  `skills/research/index.js:53-64`; `subscribeTopic()` at
  `skills/research/index.js:268-280` calls `upsertTopic`. Agent-reachable.
  It stores `keywords` exactly as the agent passes them (the array is
  trimmed + emptied-filtered inside `upsertTopic`, topics.js:24).
- ORPHANED read path: `getActiveByChatId` is exported + tested but called
  by NOTHING in production. (Confirmed: no `getActiveByChatId(` call exists
  outside topics.js + its test.)
- `search_research` declares a `topic` arg (`skills/research/index.js:46`)
  but NEVER reads it — dead parameter. Not our edit target (STOP-list).
- `scoreOf` is a STATELESS pure `(article) → number`, duplicated byte-for-byte:
  `skills/research/index.js:108-116` AND `bot/research-digest.js:42-50`.
  Today: tier +100/+50, Israeli-recruiting +30, recency `ts/1e13` tiebreaker.
- `bot/research-digest.js:16-23` carries the dup-discipline header: ranking
  changes must be made consciously in BOTH copies, OR a divergence documented.
- Article rows from `findUnsurfaced` (articles.js:82-97) are `select('*')`, so
  they carry `title`, `framing_he`, `abstract`, `tier`, `published_at`, `url`,
  `source`, `id`. CONFIRMED: `title` and `framing_he` are real columns
  (articles.js:32, 39). `title_he` is referenced by `maybePrefixFlag` but is
  NOT written by `upsertArticle` — see §7 risk.

---

## §1 Architecture (minimal-surface)

Three pieces. Entry (ADD already done; LIST/REMOVE new), surfacing (boost in
digest), and the matcher that ties them together.

### 1.1 Entry: ADD reuses existing tool; LIST/REMOVE via owner-gated `/topics`

- ADD: no new code. The agent already calls `subscribe_research_topic`.
- LIST + REMOVE: a new owner-gated `/topics` handler in `bot/telegram.js`,
  mirroring the `/blocked` owner-gate VERBATIM (telegram.js:636-657):
  silent return on non-owner, try/catch with Hebrew error fallback, lazy
  `require` of the builder. This plugs the orphaned `getActiveByChatId` into
  production (list) and uses `deactivate` (remove).

Why `deactivate` not `deleteByChatIdAndTopicPrefix` for remove: deactivate
sets `active:false` (reversible, audit-friendly) and `getActiveByChatId`
filters on `active=true`, so a deactivated topic vanishes from both the list
and the boost. `deleteByChatIdAndTopicPrefix` is a hard prefix-delete intended
for test cleanup. Recommendation: REMOVE = `deactivate`. (Q1.)

### 1.2 Message builder — new isolation file `bot/research-topics.js`

Recommendation: NEW file `bot/research-topics.js`, mirroring `research-audit.js`
(CRPS-13 precedent). It owns ONLY pure, testable, stateless helpers:

```
module.exports = {
  buildTopicsMessage,        // (rows) -> HTML string (list view)
  matchesTopic,              // (article, keywords) -> boolean
  collectKeywords,           // (topicRows) -> string[]  (flatten + dedup + filter)
  _internals: { escapeHtml, normalizeForMatch, MIN_KEYWORD_LEN },
};
```

Justification: identical reasoning to research-audit.js — telegram.js stays a
thin caller (require + owner-gate + send); the message builder and the matcher
are pure functions unit-tested without Telegram or Supabase. Keeps the
boost logic out of telegram.js entirely (telegram.js only touches the LIST
path; the digest path imports `matchesTopic`/`collectKeywords` directly).
This also keeps the matcher reusable by both the digest and any future
`search_research` wiring without a second copy. (Q6.)

### 1.3 `matchesTopic(article, keywords)` — precise spec

```
function normalizeForMatch(s) {
  return String(s == null ? '' : s).toLowerCase();
  // (nikud-stripping is an open question — see Q below + §2/§7)
}

function matchesTopic(article, keywords) {
  if (!article || !Array.isArray(keywords) || keywords.length === 0) return false;
  const hay = normalizeForMatch(article.title) + '\n' +
              normalizeForMatch(article.framing_he);
  for (const kw of keywords) {
    const k = normalizeForMatch(kw).trim();
    if (k.length < MIN_KEYWORD_LEN) continue;   // skip too-short (see Q5)
    if (hay.includes(k)) return true;
  }
  return false;
}
```

- Null-safety: `normalizeForMatch` coerces null/undefined to `''`.
- Haystack = `title` + `framing_he` joined with `\n` (so a keyword can't
  accidentally span the boundary between the two fields). Abstract NOT
  included by default (Q4).
- Case-insensitive substring (`.toLowerCase().includes`). Note: JS
  `toLowerCase` is a no-op for Hebrew (no case), so Hebrew matching is plain
  substring — correct for the resolved Gap #4.
- Short-keyword guard via `MIN_KEYWORD_LEN` (Q5; proposed 2).

### 1.4 Threading `getActiveByChatId` into the digest (the careful part)

`scoreOf` is stateless `(article) → number`. We must NOT make `scoreOf`
read a module-global (that would make it stateful and break the dup-discipline
contract + the existing tests that call `_internals.scoreOf` directly). Two
clean options; recommendation is (A):

Option A (recommended) — PRE-TAG candidates, keep scoreOf reading a field:
1. In `sendWeeklyDigest` (or `buildDigestMessage`), fetch active topics ONCE:
   `const topicRows = await topicsStore.getActiveByChatId(chatId);`
   then `const keywords = collectKeywords(topicRows);`
2. Before ranking, tag each candidate:
   `for (const a of candidates) a._topicMatch = matchesTopic(a, keywords);`
   (`_topicMatch` joins the existing `_meta`-style transient fields — it is
   NOT persisted; `findUnsurfaced` returns plain rows we mutate in memory.)
3. Extend `scoreOf` with ONE term that reads the pre-computed flag:
   `if (a._topicMatch) s += TOPIC_BOOST;`
   `scoreOf` stays a pure `(article) → number` — it reads a field on the
   article, exactly like it already reads `a.tier` and `a._meta`. No global,
   no signature change. Tests that call `_internals.scoreOf({tier:1})` keep
   passing (no `_topicMatch` → no boost).

Concrete shape of the digest change (research-digest.js):
- `buildDigestMessage`: add `deps.topicsStore` (default the real store) and,
  after `findUnsurfaced`, fetch keywords + tag candidates, then rank as today.
- `scoreOf`: add the single `if (a._topicMatch) s += TOPIC_BOOST;` line.
- This is the ONE allowed edit zone per the dup-discipline header (§4).

Option B (rejected for MVP) — wrap scoreOf in a closure that captures the
keyword set. Cleaner conceptually but changes the call sites in `rankArticles`
and would require touching both copies' signatures + the `_internals` test
contract. More surface for no MVP benefit.

### 1.5 Boost value relative to tier=100/50, Israel=30

Resolved constraint: the boost must NOT flip tier ordering unless intended.
A subscribed Tier-2 article should NOT outrank a non-subscribed Tier-1.

- Tier-1 base = 100, Tier-2 base = 50. Gap = 50.
- Israeli-recruiting = +30 (sits inside a tier, never crosses 50).
- Proposed `TOPIC_BOOST = 25`.
  - Tier-2 + topic = 50 + 25 = 75 < 100 (Tier-1 floor). Does NOT flip tiers. ✅
  - Within a tier, a topic match (+25) outweighs Israeli-recruiting (+30)?
    No — 30 > 25, so Israeli-recruiting still wins ties within a tier, with
    topic-match as a strong secondary. A Tier-2 topic-match (75) beats a
    plain Tier-2 (50) and a Tier-2 Israeli (80 > 75 — Israeli still leads).
  - This keeps tier as the dominant axis (Shilo's safety filter integrity),
    Israeli-recruiting second, topic-interest third — all WITHIN tier.
- Alternative if Shilo wants topics to dominate within a tier: `TOPIC_BOOST=35`
  (beats Israeli +30 but still < 50 gap). Decision = Q2.

### 1.6 Files touched + LOC estimate

| File | Change | Est. LOC |
|------|--------|----------|
| `bot/research-topics.js` | NEW isolation file: `matchesTopic`, `collectKeywords`, `buildTopicsMessage`, helpers | ~90 |
| `bot/telegram.js` | NEW `/topics` owner-gated handler (list + remove), mirrors /blocked | ~35 |
| `bot/research-digest.js` | fetch topics + tag candidates in `buildDigestMessage`; +1 line in `scoreOf`; update dup-discipline header | ~15 |
| `tests/research_topics.test.js` | NEW: matchesTopic + buildTopicsMessage cases | ~120 |
| `tests/research_digest.test.js` | +1 boost-integration case | ~25 |
| `docs/research/01j-...` | this doc | — |

No edits to: topics.js storage, articles.js, skills/research/index.js,
classifier/keywords/tiers, research-audit.js, blocked-log.js.

---

## §2 Keyword matching spec (Gap #4 resolved)

- Match target: `title` (English) + `framing_he` (Hebrew). A subscription in
  either language works because both fields are scanned.
- `abstract`: NOT scanned by default. Including it would raise recall but the
  abstract is long English text → many incidental substring hits → noisy
  boosts, and articles.js header warns the abstract is PHI-adjacent (never
  logged). Recommend exclude for MVP. (Q4.)
- Case-insensitive substring (`toLowerCase().includes`). Hebrew has no case so
  it degrades to plain substring (correct).

### How keywords are stored / extracted
- `subscribe_research_topic` (index.js:53-64) takes `topic` (string) + optional
  `keywords` (string[]). `subscribeTopic` (index.js:268-280) passes them to
  `upsertTopic`, which trims each keyword and drops empties (topics.js:24).
- IMPORTANT: keywords come from the LLM's free-text → tool-call extraction.
  If the user says "subscribe me to ketamine", the agent decides what goes in
  `keywords[]`. The `topic` label itself is NOT automatically a keyword.
  Design decision: `collectKeywords(topicRows)` should include BOTH each row's
  `keywords[]` AND its `topic` string, so a topic with no explicit keywords
  still matches on its label. (Confirm — implied by Q1/Q4 discussion.)

```
function collectKeywords(topicRows) {
  const out = new Set();
  for (const r of topicRows || []) {
    if (r && r.topic) out.add(String(r.topic).trim().toLowerCase());
    for (const k of (r && Array.isArray(r.keywords) ? r.keywords : [])) {
      const t = String(k).trim().toLowerCase();
      if (t) out.add(t);
    }
  }
  return [...out].filter(k => k.length >= MIN_KEYWORD_LEN);
}
```

### Edge cases
- Empty keywords + empty topic: `collectKeywords` returns `[]` →
  `matchesTopic` returns false → digest behaves EXACTLY as today (graceful
  no-op). This is the zero-subscription default and must stay byte-identical
  to current behavior.
- Very short keywords (1-2 chars): e.g. "IV", "ה" → huge false-match surface.
  Guard with `MIN_KEYWORD_LEN` (Q5, proposed 2 — note "IV" is exactly 2;
  if MIN=3, "IV" is dropped, which is wrong for a real CRPS term. Lean MIN=2.)
- Hebrew nikud / prefixes (ה/ו/ב/ל/מ/ש): substring match will MISS "בקטמין"
  when keyword is "קטמין" (prefix attached). And nikud marks break equality.
  MVP: document as a known limitation (§7); do NOT build a Hebrew stemmer now.
- Duplicate keywords across topics: `collectKeywords` dedups via Set.

---

## §3 Message format for `/topics`

Subcommand grammar (proposed; Q1):
- `/topics` → list active subscriptions, numbered.
- `/topics remove N` → deactivate the N-th topic from the last-shown list
  (1-based, ordered by `created_at` asc, matching `getActiveByChatId`).

Regex (mirrors /blocked's optional-arg style, telegram.js:636):
`/^\/topics(?:@\w+)?(?:\s+remove\s+(\d+))?$/`
- no arg → list; `remove N` → deactivate index N.

Rendered list mock (HTML, owner only):
```
🎯 הנושאים שאתה עוקב אחריהם (3):

1. קטמין — מילים: ketamine, IV ketamine
2. גירוי עצבי — מילים: DRG, spinal cord stimulation
3. פיזיותרפיה — מילים: (אין)

להסרה: שלח /topics remove <מספר>
```

Empty state:
```
🎯 אין נושאים פעילים.

כדי להירשם, פשוט תכתוב לי משהו כמו "תעקוב אחרי מחקרים על קטמין".
```

Remove confirmation:
```
✅ הוסר מהמעקב: קטמין
```
Remove with bad index:
```
⚠️ אין נושא במספר 5. שלח /topics לרשימה.
```

- Index→topic resolution: `/topics remove N` re-fetches `getActiveByChatId`,
  picks `rows[N-1]`, calls `deactivate(chatId, rows[N-1].topic)`. Stateless
  (no need to cache the prior list — re-derive the same `created_at` order).
- Telegram limits: topic counts are tiny (single user); no pagination needed.
  `escapeHtml` topic/keyword strings (they could contain `<`/`&`).
- Owner-gate copied VERBATIM from /blocked (silent return on non-owner).

---

## §4 STOP-list (0 edits outside the one allowed zone)

DO NOT TOUCH:
- Hope Filter: classifier.js, keywords.js, tiers.js (tier assignment).
- `/research` handler (telegram.js:586-609).
- `/digest_now` handler (telegram.js:613-630).
- `/blocked` handler (telegram.js:636-657) — copy its gate, don't modify it.
- `bot/research-audit.js`.
- `skills/research/storage/articles.js` core read fns (findUnsurfaced etc.).
- `skills/research/storage/blocked-log.js`.
- `skills/research/storage/topics.js` — storage is DONE; reuse as-is.
- `skills/research/index.js` — including the unused `topic` arg on
  `search_research` (index.js:46). NOT in MVP scope. Leave the orphaned arg.

THE ONE ALLOWED EDIT ZONE: `bot/research-digest.js`.
- Permitted: add topic-fetch + candidate-tagging in `buildDigestMessage`; add
  the single `if (a._topicMatch) s += TOPIC_BOOST;` line in `scoreOf`.
- Dup-discipline (header lines 16-23): the digest `scoreOf` is a byte-copy of
  `skills/research/index.js:108-116`. This change DIVERGES the two.
  RECOMMENDATION (Q3): digest-only divergence. The `/research` live-search
  path (index.js scoreOf) does NOT yet read topics and is out of MVP scope;
  intentionally NOT mirroring there. Document the divergence by UPDATING the
  header block (research-digest.js:16-23) to state: "DELIBERATE DIVERGENCE
  (CRPS-11): the digest scoreOf adds a `_topicMatch` boost term that the
  skills/research copy does NOT have. The non-tier/non-Israel terms are no
  longer byte-equivalent. Re-sync requires CRPS-11 work in skills/research."
  This keeps the divergence conscious and discoverable, satisfying the header.

---

## §5 Test plan (mirror existing conventions: node:test + assert/strict)

New file `tests/research_topics.test.js`:
- `matchesTopic` — Hebrew keyword hits `framing_he` ("קטמין" in framing).
- `matchesTopic` — English keyword hits `title` ("ketamine" in title).
- `matchesTopic` — case-insensitivity ("KETAMINE" keyword vs "ketamine" title).
- `matchesTopic` — substring ("ketam" matches "ketamine").
- `matchesTopic` — empty keywords → false (graceful no-op).
- `matchesTopic` — null article / null fields → false (no throw).
- `matchesTopic` — short keyword below MIN_KEYWORD_LEN is skipped.
- `collectKeywords` — flattens topic + keywords, dedups, drops short/empty.
- `buildTopicsMessage` — 0 active → empty-state text.
- `buildTopicsMessage` — N active → numbered list, "(אין)" for no-keyword row,
  escapeHtml applied.

Extend `tests/research_digest.test.js` (mirror the makeStoreStub pattern):
- boost integration: 1 Tier-2 article matching a subscribed keyword + several
  plain Tier-2 → the matching one ranks above the non-matching Tier-2 (floats
  toward top-5). Stub `deps.topicsStore.getActiveByChatId` to return one topic.
- regression: with `getActiveByChatId` → `[]`, digest output is identical to
  the pre-CRPS-11 ordering (proves zero-subscription no-op).
- still-passing: `_internals.scoreOf({tier:1})` returns 100 (no `_topicMatch`
  field → no boost) — proves scoreOf stayed pure.

`/topics` handler: per project convention telegram.js handlers are tested via
the extracted pure builders (`buildTopicsMessage`), not the bot wiring (same as
/blocked → research-audit tests). Owner-gate + remove-index logic: cover the
index→deactivate resolution in a small handler-logic test if a seam exists;
otherwise document as manual-smoke (see §7 live-check). (Q: acceptable?)

---

## §6 Questions for Shilo (answer before any code)

- Q1: `/topics` grammar — `/topics` list + `/topics remove N` (my proposal),
  or list + a separate `/unsubscribe` command? And REMOVE = `deactivate`
  (reversible, my lean) or hard `delete`?
- Q2: `TOPIC_BOOST` value — 25 (topic ranks below Israeli-recruiting within a
  tier, never flips tiers — my lean) or 35 (topic beats Israeli within a tier)?
- Q3: scoreOf dup — digest-only divergence with an updated header note (my
  lean, since /research search doesn't use topics yet), or mirror the boost
  into skills/research/index.js too?
- Q4: match `abstract` as well, or just `title` + `framing_he` (my lean:
  title + framing_he only — abstract is noisy + PHI-adjacent)?
- Q5: `MIN_KEYWORD_LEN` — 2 (keeps "IV", my lean) or 3 (drops 2-char terms)?
- Q6: isolation file `bot/research-topics.js` (my lean, mirrors
  research-audit.js) or inline in telegram.js + research-digest.js?
- Q7: should the topic LABEL itself count as a keyword (so a label-only
  subscription still matches), or ONLY the explicit `keywords[]`? (My lean:
  include the label.)
- Q8: when the digest boosts a topic-matched article, do you want a visual
  marker in the message (e.g. "🎯" prefix on matched items) so you can SEE the
  prioritization worked, or keep the message format byte-identical to today?

---

## §7 Honest gaps / risks

- LIVE-CHECK NEEDED: `subscribe_research_topic` has never been verified live
  (likely 0 rows in `research_topics`). Before/with implementation, run a real
  end-to-end: tell the bot to subscribe to a topic, then query the table (or
  `/topics`) to confirm a row with non-empty `keywords[]` actually lands.
  Risk: if the LLM tends to call the tool with `topic` only and empty
  `keywords[]`, then Q7 (label-as-keyword) becomes load-bearing for ANY match
  to ever fire.
- `framing_he` IS a confirmed column (articles.js:39, written by
  `upsertArticle`). But it is nullable — Tier-2 articles often have it; some
  rows may be null. Matcher handles null safely; just noting recall depends on
  framing_he being populated by the classifier.
- `title_he` is referenced by `maybePrefixFlag` (research-digest.js:38) but is
  NOT written by `upsertArticle` (no `title_he` in the row, articles.js:27-41).
  Not our bug to fix, but it means the digest currently shows English `title`
  for non-Israeli items. Matching on `title` (English) is therefore correct.
- Hebrew substring pitfalls: prefixes (ה/ו/ב/ל/מ/ש attached to a noun) and
  nikud will cause MISSES (false negatives, not false positives). MVP accepts
  this; a Hebrew-aware normalizer (strip nikud, strip leading one-letter
  prefixes) is a deliberate future enhancement, NOT in scope. Flagging so the
  recall expectation is honest: English keywords will match more reliably than
  Hebrew ones until normalization is added.
- Stateful-scoreOf risk: NEUTRALIZED by Option A (pre-tag a transient
  `_topicMatch` field; scoreOf stays pure). If a future dev instead reaches
  for a module-global keyword set, it WILL break the `_internals.scoreOf`
  unit-test contract and the dup-discipline — call this out in the header.
- `_topicMatch` field-name collision: low risk, but confirm no existing code
  reads `_topicMatch` (grep shows none today). Using the `_`-prefix transient
  convention consistent with `_meta`.

## STOP

Design complete. Awaiting Shilo's answers to Q1-Q8 before writing any code.
No source files were modified; only this design doc was written.

---

## §8 Merge record (CRPS-11.M)

Merged to `main` via `--no-ff`, merge SHA **`297da80`**, on 2026-06-01 (Asia/Jerusalem).

Branch `feature/crps-11-topic-subscriptions`:
- `59d7a4e` feat — `/topics` + digest boost (3 prod files + 2 tests, +440/-4)
- `a9a26ee` docs — this design doc

Decisions (all architect leans accepted): Q1 `/topics` list + `/topics remove N` (→ `deactivate`,
reversible); Q2 `TOPIC_BOOST=25` (below Israeli +30, never flips tiers); Q3 digest-only divergence
(boost NOT mirrored to `skills/research/index.js`, documented in research-digest.js header);
Q4 match `title` + `framing_he` only (not abstract); Q5 `MIN_KEYWORD_LEN=2`; Q6 isolation file
`bot/research-topics.js`; Q7 label-as-keyword (load-bearing); Q8 🎯 marker on boosted items.

QA (Phase 5): GO. 270/270 tests (244 prior + 26 new), zero regression. Behavioral smoke confirmed
matchesTopic (Hebrew + English, null-safe, MIN_LEN, no boundary-span), buildKeywordSet label-only
fallback (Q7), buildTopicsMessage (list + empty + HTML escaping), and digest boost end-to-end:
+25 exact, 🎯 rendered, and crucially NO tier-flip (T2+topic=75 < plain T1=100). scoreOf stays a
pure `(a)→number`; `_topicMatch` tagged before scoring. 0 STOP-list violations — Hope Filter,
`/research`, `/digest_now`, `/blocked`, `research-audit.js`, `articles.js`, `blocked-log.js`,
`topics.js`, and `skills/research/index.js` scoreOf all untouched.

`framing_he` confirmed real column (articles.js:39, carried by `findUnsurfaced`'s `select('*')`).

Carry-forward (not blockers, no follow-up scheduled):
- `subscribe_research_topic` never verified live (0 rows) — recommend one manual `/topics`
  round-trip (NL subscribe → `/topics` → `/topics remove N`) on staging before relying in prod.
- Hebrew prefix/nikud false-negatives (plain substring, no stemmer) — known/accepted MVP limitation.

Live verification pending: the topic-boost first fires in the Sunday 09:00 IL digest after the next
Render redeploy (owner chat_id 758752313), and only if at least one topic has been subscribed.
