# CRPS-13 — Tier 3 Audit Dashboard — Design (Phase 2 / @architect)

Status: DESIGN ONLY. No code written. Awaiting Shilo's answers to Q1–Q9 before any implementation.
Author: Winston (BMAD Architect)
Date: 2026-05-31
Delivery decision (Shilo APPROVED): Option A — owner-gated Telegram command, isolation pattern per `bot/research-digest.js`.

> Grounding note: All five source files referenced below were re-read fresh this session and line numbers are
> VERIFIED: `skills/research/storage/blocked-log.js` (1–67), `skills/research/storage/articles.js` (1–147),
> `bot/research-digest.js` (1–134), `bot/telegram.js` (582–630), `skills/research/index.js` (190–227),
> `tests/research_storage_blocked_log.test.js` (1–118), `tests/research_digest.test.js` (1–269). No line number
> in this doc is a guess. Open items are honest unknowns, listed in §7.

---

## §0 Goal (one line)

Give Shilo a read-only, owner-only way to review the 23 rows the "Hope Filter" blocked (`research_blocked_log`),
grouped by reason, so he can spot the filter over-blocking (overshoot) or under-blocking (undershoot) — pure
transparency, zero behavior change to the filter.

---

## §1 Architecture (minimal-surface)

Three additions, each mirroring a verified existing pattern. Nothing in the Hope Filter or the agent path changes.

### 1.1 New read function — `listBlocked(limit, client)`

File: `skills/research/storage/blocked-log.js`. ADD a 4th function alongside the existing three —
`appendBlocked` (19–39), `countSince` (41–49), `deleteBySourceIdPrefix` (51–59) — and one line to
`module.exports` (61–66). All VERIFIED.

It mirrors `getHistory` in `articles.js:111–121` (VERIFIED) AND reuses this file's own conventions:
- `const TABLE = 'research_blocked_log'` (blocked-log.js:11) — reuse, do not re-declare.
- `getClient(injected)` helper (blocked-log.js:13–17) — the injectable-client pattern. `listBlocked` must use the
  SAME `client = null` → `const c = getClient(client)` idiom the other three functions use (lines 20, 42, 52),
  NOT a `client = supabase` default param.
- The `.limit(Math.min(Math.max(1, Number(limit) || N), MAX))` clamp idiom from `getHistory` (articles.js:118)
  — guards against absurd limits.
- The `throw new Error('listBlocked failed: ...')` error style (matches lines 37, 47, 58, and articles.js:119).

Intended shape (NOT final code — illustrative signature only, matching this file's verified idiom):

```
// returns newest-first array of blocked rows, capped + clamped at `limit`
async function listBlocked(limit = 25, client = null) {
  const c = getClient(client);
  const { data, error } = await c
    .from(TABLE)
    .select('source, source_id, title, url, blocked_at, blocked_by, reason_code, classifier_rationale')
    .order('blocked_at', { ascending: false })
    .limit(Math.min(Math.max(1, Number(limit) || 25), 100));
  if (error) throw new Error(`listBlocked failed: ${error.message}`);
  return data || [];
}
```

Note: `appendBlocked` (21–29) writes columns `source, source_id, title, url, blocked_by, reason_code,
classifier_rationale` and never a `chat_id` — so the `select` list above is the real column set, and the
no-`chat_id` fact (which forces the owner-gate in §1.2) is VERIFIED, not assumed. `blocked_at` is not written by
`appendBlocked`, so it is a DB-default timestamp column (assumed server-set; §7 item 3).

LOC estimate: ~12 lines (function) + 1 export line = ~13.

### 1.2 New owner-gated command handler — in `bot/telegram.js`

Mirror the `/digest_now` owner-gate VERBATIM. The verified predicate (telegram.js:613–618) is:

```
bot.onText(/^\/digest_now(?:@\w+)?(?:\s+.*)?$/, async (msg) => {
  const ownerId = Number(process.env.TELEGRAM_CHAT_ID);
  if (!ownerId || msg.chat.id !== ownerId) {
    console.log('[/digest_now] denied — chat', msg.chat.id, 'is not owner');
    return;                       // silent denial — no reply to non-owner
  }
  ...
```

Important correction vs the brief: the real gate uses `const ownerId = Number(process.env.TELEGRAM_CHAT_ID)`
with a `!ownerId ||` null-guard, and **silently returns** (no "not authorized" reply) on denial. There is NO
`ALERT_CHAT_ID` fallback in this handler (despite CLAUDE.md mentioning one elsewhere). Copy this exact shape.

Why the gate is mandatory: `research_blocked_log` has no `chat_id` column (VERIFIED, §1.1) → global data.

The new handler (regex `^\/blocked(?:@\w+)?(?:\s+.*)?$`, matching the `/research` + `/digest_now` regex style at
586/613):
1. Owner-gate (copy 614–618 verbatim).
2. `const rows = await listBlocked(LIMIT)`.
3. `const text = buildAuditMessage(rows)` (see §1.3, §3).
4. `bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' })` — HTML matches both `/research` (604) and the
   digest sender (research-digest.js:111).
5. try/catch with `console.error('[/blocked]', err.message)` + a Hebrew error reply (mirrors 605–608 / 626–629).

LOC estimate: ~18–24 lines in `telegram.js` (one new command branch).

### 1.3 Hebrew message builder — RECOMMENDATION: new file `bot/research-audit.js`

Decision: **new file `bot/research-audit.js`**, NOT inline. (Confirm via Q4.)

Justification (backed by the verified `research-digest.js`):
- `research-digest.js` is the explicit isolation precedent. Its header (lines 10–14) declares the exact
  STOP-discipline we need: "Zero modification to skills/research/index.js … Zero modification to
  bot/telegram.js /research handler (the /digest_now manual trigger is a NEW handler, separate code path)." The
  audit feature is the direct sibling; placing it in `research-audit.js` next to `research-digest.js` keeps the
  parallel obvious.
- `research-digest.js` keeps `telegram.js` thin: it exports `buildDigestMessage` (71) and `sendWeeklyDigest`
  (96); the telegram handler just `require`s and calls them (621–622). We replicate that — `telegram.js` only
  gates + calls + sends.
- It exposes test seams via `module.exports` + an `_internals` block (research-digest.js:122–133). We mirror
  that so the normalization map (§2) is unit-testable without booting the bot — exactly how
  `research_digest.test.js:22` imports `{ buildDigestMessage, _internals }`.

`bot/research-audit.js` exports:
- `buildAuditMessage(rows, opts)` — the Hebrew renderer (§3), a pure function over rows (mirrors
  `buildDigestMessage`'s pure-builder contract).
- `_internals: { normalizeReason, REASON_MAP, REASON_FALLBACK, groupByReason, escapeHtml }`.

LOC estimate: ~70–90 lines (map ~22, normalizeReason ~6, groupByReason ~8, buildAuditMessage ~45, escapeHtml ~4,
exports ~6).

### 1.4 Files touched + LOC summary

| File | Change | Est. LOC |
|------|--------|----------|
| `skills/research/storage/blocked-log.js` | ADD `listBlocked` + 1 export line | +13 |
| `bot/research-audit.js` | NEW file (map + normalizeReason + groupByReason + escapeHtml + buildAuditMessage) | +84 |
| `bot/telegram.js` | ADD one owner-gated command branch | +22 |
| `tests/research_storage_blocked_log.test.js` | ADD cases for `listBlocked` | +35 |
| `tests/research_audit.test.js` (NEW) | normalizeReason + groupByReason + buildAuditMessage | +70 |
| **Total** | | **~224 LOC**, of which ~105 is test code |

Net production surface: **~119 LOC across 3 production files, one of them brand new and isolated.** No edits to
any Hope Filter file, classifier, keywords, tiers, the `appendBlocked` call site, the `/research` handler,
`research-digest.js`, the existing 3 functions in `blocked-log.js`, or `articles.js` (see §4 STOP-list).

---

## §2 `reason_code` normalization mapping (DISPLAY ONLY — never mutates stored rows)

Problem (Phase 1 real data): stored `reason_code` values are inconsistently cased and use synonym variants for
the same concept. We collapse these **only when rendering**. The read path is a pure `select` (§1.1) and never
writes — casing is fixed in display, never in storage.

Note also (VERIFIED at index.js:209): the writer stores `reason_code: classification.block_reason || 'unknown'`,
so `'unknown'` is a legitimately-occurring stored value and must map cleanly (→ fallback bucket). This is why the
fallback bucket is not merely theoretical.

Normalization algorithm:
1. `key = String(reasonCode || '').trim().toLowerCase().replace(/\s+/g, '_')` — case-, whitespace-, and
   separator-insensitive. The `\s+ → _` step unifies `"Irrelevant content"` with `irrelevant_content`
   (conditional on **Q6**).
2. Look `key` up in `REASON_MAP`.
3. If found → return its Hebrew label.
4. Else (incl. empty/null/`'unknown'`) → fallback `"אחר / לא מסווג"` (see Q5).

Mapping table (JS-object-shaped; keys are already normalized so lookup is exact):

```js
// DISPLAY ONLY. Maps normalized(reason_code) -> Hebrew bucket label.
// Counts in comments are the real Phase 1 distribution across the 23 rows.
const REASON_MAP = {
  // → "תופעות לוואי לא רלוונטיות" (4)
  side_effects_unsolicited:        'תופעות לוואי לא רלוונטיות',

  // → "פסימיות פרוגנוסטית" (4)  [catches prognosis_pessimism + PROGNOSIS_PESSIMISM via toLowerCase]
  prognosis_pessimism:             'פסימיות פרוגנוסטית',

  // → "לא רלוונטי ל-CRPS" (11, across 6 synonym spellings)
  irrelevant_topic:                'לא רלוונטי ל-CRPS', // also "Irrelevant_topic"
  irrelevant_content:              'לא רלוונטי ל-CRPS', // also "Irrelevant content" (space→_ via Q6)
  irrelevant_condition:            'לא רלוונטי ל-CRPS',
  off_topic:                       'לא רלוונטי ל-CRPS', // "OFF_TOPIC"

  // → "סטטיסטיקות תמותה" (2)
  mortality_stats:                 'סטטיסטיקות תמותה',

  // → "תיאור גרפי" (1)
  graphic_procedure_description:   'תיאור גרפי',

  // → "תוכן מטעה" (1)
  misleading_content:              'תוכן מטעה',
};

const REASON_FALLBACK = 'אחר / לא מסווג';

function normalizeReason(reasonCode) {
  const key = String(reasonCode || '').trim().toLowerCase().replace(/\s+/g, '_');
  return REASON_MAP[key] || REASON_FALLBACK;
}
```

Coverage check: 4 + 4 + 11 + 2 + 1 + 1 = **23 rows = the full table.** Fallback should hit 0 of today's 23 rows,
but exists so future `'unknown'`/unseen codes degrade gracefully instead of showing a raw machine code to Shilo.

Subtlety flagged as **Q6**: the `\s+ → _` step. With it, `"Irrelevant content"` → `irrelevant_content` and the
"לא רלוונטי" bucket reads 11. Without it, that one row falls to fallback and the count reads 10 — exactly the
audit-count discrepancy this feature exists to prevent. My lean: keep the step.

---

## §3 Message format (Hebrew `/blocked` message)

Constraints:
- Telegram hard limit: 4096 chars. Never overflow.
- 23 rows × (title + source + date + reason) could approach the limit; titles are the unbounded part.

Strategy (default; final shape is Q2/Q3):
- **Always show** the grouped-by-reason summary (bounded: ≤7 buckets, tiny).
- **Then the last N titles** (newest-first), default N=10, each truncated to ~60 chars. 10 × ~90 chars ≈ 900
  chars + summary ≈ well under 4096. The grouped summary is the guaranteed-present part.

`buildAuditMessage(rows, { titleLimit = 10 })` — pure function over rows, returns a string (mirrors
`buildDigestMessage`, research-digest.js:71–92):
1. `total = rows.length`.
2. Group via `normalizeReason(row.reason_code)`, tally per bucket, sort desc by count.
3. Render header + grouped summary.
4. Render last `titleLimit` rows: title (truncated, HTML-escaped), source, date (`blocked_at` → IL date),
   bucket, a pre_filter-vs-llm_classifier tag.
5. `blocked_by` legend: `appendBlocked` enforces it is exactly `'pre_filter' | 'llm_classifier'`
   (blocked-log.js:26, 33–35) — safe to switch on those two literals, no third case.
6. `classifier_rationale` is NULL for pre_filter rows (`appendBlocked` stores `|| null`, line 28) → render `—`
   or omit when null. Never crash on null.

HTML: send `parse_mode: 'HTML'` (matches /research:604 and digest:111) which uses `<b>`, `<i>`, `<a href>`. So
titles (external/untrusted text) MUST be HTML-escaped (`&`,`<`,`>`) — small `escapeHtml` helper in
`research-audit.js`. The existing `/research` and digest code do NOT escape titles (a latent bug there); we do
NOT touch them, but our new code should escape (T19).

Concrete rendered mock (illustrative; counts are the real Phase 1 distribution; titles are placeholders):

```
🛡️ <b>דוח חסימות — Hope Filter</b>
סה"כ נחסמו: 23 מאמרים

לפי סיבה:
• לא רלוונטי ל-CRPS — 11
• תופעות לוואי לא רלוונטיות — 4
• פסימיות פרוגנוסטית — 4
• סטטיסטיקות תמותה — 2
• תיאור גרפי — 1
• תוכן מטעה — 1

🕑 10 האחרונים:
1. New study links chronic pain to… · PubMed · 30/05 · פסימיות פרוגנוסטית · 🤖
2. Amputation outcomes after failed… · Reddit · 29/05 · תיאור גרפי · 🤖
3. Best running shoes for flat feet · NewsAPI · 28/05 · לא רלוונטי ל-CRPS · ⚙️
4. Mortality rates in advanced… · PubMed · 27/05 · סטטיסטיקות תמותה · 🤖
5. Side effects of gabapentin you… · NewsAPI · 26/05 · תופעות לוואי לא רלוונטיות · 🤖
…(עוד 5)

⚙️ = חסימת חוק (pre_filter) · 🤖 = חסימת AI (llm_classifier)
```

The ⚙️/🤖 legend is the core audit affordance: it lets Shilo tell whether overshoot came from the cheap rule
layer (pre_filter) or the LLM classifier.

---

## §4 STOP-list (0 violations allowed)

This design touches NONE of the following. Any future implementation PR that touches these is rejected.

1. **Hope Filter internals** — `filter/classifier.js`, `filter/keywords.js`, `filter/tiers.js`. Not opened, not changed.
2. **The `appendBlocked` call site** — `skills/research/index.js:201–217` (VERIFIED). The write path is untouched.
3. **`/research` handler** — `bot/telegram.js:586–609` (VERIFIED). New command is a separate branch, exactly as `research-digest.js:11–14` declares for `/digest_now`.
4. **`bot/research-digest.js`** — read in full for the pattern (1–134, VERIFIED); NOT modified.
5. **The existing 3 functions** in `blocked-log.js` — `appendBlocked` (19–39), `countSince` (41–49), `deleteBySourceIdPrefix` (51–59). ADDING `listBlocked` is explicitly OK; editing these three is NOT. `getClient`/`TABLE` (11–17) may be REUSED but not modified.
6. **`skills/research/storage/articles.js`** — read for the `getHistory` precedent only (1–147, VERIFIED); NOT modified.

Additional self-imposed STOP guarantees:
- No UPDATE/DELETE on `research_blocked_log`. `listBlocked` is a pure `select`. Casing fixed in display, never in storage.
- Owner-gate copied VERBATIM from `/digest_now` (614–618), including the silent-return-on-denial behavior.
- Feature bypasses the agent (Option A) → no change to `agent.js`, `skills-registry.js`, tool descriptions, or the `JSON.stringify` Gemini guard.

---

## §5 Test plan

Mirror VERIFIED conventions: `tests/research_storage_blocked_log.test.js` uses a `mockClient(routes)` Proxy that
records `ops` and resolves on `.then` (lines 8–30); `tests/research_digest.test.js` tests pure builders on
fixture rows + a `_internals` presence check (22, 86–109, 259–268). Framework: `node:test` + `node:assert/strict`.
No live Supabase, no live Telegram.

### 5.1 `listBlocked` (add to `tests/research_storage_blocked_log.test.js`, reuse its `mockClient`)
- T1: returns newest-first — assert `ops` contains `['order','blocked_at',{ascending:false}]`.
- T2: respects/clamps `limit` — assert `.limit(...)` op present; with limit=5 returns ≤5 from a 23-row route.
- T3: empty table (`{data: null}`) → returns `[]`, not null, no throw (matches `return data || []`).
- T4: Supabase `error` route → rejects with `/listBlocked failed/`.
- T5: selects exactly the 8 columns — assert the `select` op's arg string.
- T6: injected `client` is honored (pass `mockClient`, confirm it was used) — matches the `client = null` → `getClient` contract of the other 3 functions.

### 5.2 `normalizeReason` (new `tests/research_audit.test.js`, import via `_internals`)
- T7: each of the 7 known buckets → its Hebrew label.
- T8: case-insensitive — `PROGNOSIS_PESSIMISM` and `prognosis_pessimism` both → "פסימיות פרוגנוסטית".
- T9: synonym collapse — `irrelevant_topic`, `OFF_TOPIC`, `irrelevant_content`, `irrelevant_condition` all → "לא רלוונטי ל-CRPS".
- T10: spaced variant — `"Irrelevant content"` → "לא רלוונטי ל-CRPS" (encodes the Q6 decision).
- T11: `'unknown'` (the real index.js:209 default) → fallback "אחר / לא מסווג".
- T12: null / undefined / "" → fallback (no throw).

### 5.3 `buildAuditMessage` (new `tests/research_audit.test.js`)
- T13: header shows correct total (23 on full fixture).
- T14: grouped summary counts match the §2 distribution (11/4/4/2/1/1).
- T15: respects `titleLimit` — only N titles rendered.
- T16: output length < 4096 even on a 23-row fixture with long titles.
- T17: null `classifier_rationale` (pre_filter rows) renders without crashing.
- T18: `blocked_by` legend / tag distinguishes pre_filter vs llm_classifier.
- T19: HTML-escapes `<`, `>`, `&` in a malicious/odd title.

---

## §6 Numbered questions for Shilo (answer before implementation)

- **Q1 — Command name?** `/blocked` vs `/audit` vs `/tier3`. (My lean: `/blocked` — most self-describing. `/audit` fine too.)
- **Q2 — How many entries to show?** All 23, last 10, or grouped summary + count only (no titles)? (My lean: grouped summary + last 10 titles — fits 4096, best for spotting overshoot.)
- **Q3 — Message format?** Grouped summary only / full list only / both (summary + last N)? (My lean: both, per §3.)
- **Q4 — Isolation file or inline?** New `bot/research-audit.js` (my recommendation, §1.3, backed by the verified `research-digest.js` isolation header) vs inline in `telegram.js`. Confirm?
- **Q5 — Unknown / `'unknown'` `reason_code`s?** Fallback bucket "אחר / לא מסווג" (recommended), raw code shown so nothing is hidden, or both (bucket + raw in parens)?
- **Q6 — Space→underscore normalization?** Collapse `"Irrelevant content"` with `irrelevant_content` (count 11 vs 10)? (My lean: yes — §2.)
- **Q7 — Argument support?** Accept an optional count, e.g. `/blocked 20`, to override the title limit? (The regex `(?:\s+.*)?` already tolerates args; parsing is +~4 LOC. My lean: nice-to-have, default off unless wanted.)
- **Q8 — Date filtering?** Any time window (e.g. last-7-days), or always newest-first regardless of date? (My lean: no date filter for v1 — 23 rows is small.)
- **Q9 — Denial behavior?** `/digest_now` denies SILENTLY (no reply to non-owner). Match that (recommended — least info leak), or send a "לא מורשה" reply? (My lean: match `/digest_now` — silent.)

---

## §7 Honest gaps / risks

1. **Owner-gate predicate corrected vs brief.** The brief said `msg.chat.id === Number(process.env.TELEGRAM_CHAT_ID)`. The VERIFIED handler (telegram.js:614–618) adds a `!ownerId ||` null-guard and returns SILENTLY (no reply). I aligned the design to the real code. No `ALERT_CHAT_ID` fallback exists in this handler. Action: copy 614–618 verbatim.

2. **`blocked_at` column source.** `appendBlocked` (21–29) does NOT write `blocked_at`, and `countSince` filters on it (`.gte('blocked_at', ...)`, line 46) — so it is a server-default timestamp column. Format (ISO UTC vs IL-local) is not visible in code I can read. Action at code time: confirm the column type, and render the date with the project's existing IL formatter (`formatTimeIL`, per CLAUDE.md) rather than raw `toLocaleDateString`.

3. **`'unknown'` is a real stored value.** index.js:209 stores `reason_code: classification.block_reason || 'unknown'`. The Phase 1 distribution of 23 sums exactly without `'unknown'`, so none are present today — but the fallback bucket (Q5) is what catches it if it appears. Confirmed, not a guess.

4. **HTML-escaping gap in existing code.** `/research` (596–600) and the digest (research-digest.js:81–84) interpolate raw titles into HTML without escaping — a latent injection/rendering bug in THOSE files. STOP-list forbids touching them. Our new code escapes (T19); we do not "fix" theirs. Flagging so the difference is intentional and visible.

5. **`"Irrelevant content"` spaced variant** (§2 / Q6). If Q6 = no space-normalization, the "לא רלוונטי" count reads 10 instead of 11 — a real audit-count discrepancy. Hence the question.

6. **Count reconciliation.** §2 sums Phase 1 to exactly 23. If the live table has drifted since Phase 1, grouped counts reflect live data (correct), but the §3 mock will look off vs reality. The mock is illustrative only.

7. **4096-char safety is arithmetic, not measured.** T16 is the guardrail; until it runs on a real 23-row fixture, headroom is asserted from §3 math.

8. **No pagination.** Fine for 23 rows. If the table grows to hundreds, "last N titles" silently hides older blocks — out of scope for v1; note for a future CRPS ticket.

---

## STOP

Design complete. The only file written is this design doc; no source/feature code was created or modified.
Awaiting Shilo's answers to **Q1–Q9** before any implementation. Before Phase 3, the implementer must clear §7
item 2 (`blocked_at` format + IL formatter) — everything else is already verified against live source.

---

## §8 Merge record (CRPS-13.M)

Merged to `main` via `--no-ff`, merge SHA **`e23719c`**, on 2026-05-31 (Asia/Jerusalem).
Fourth and final CRPS Phase 5+ enhancement.

Branch `feature/crps-13-tier3-audit`:
- `1623fb4` feat — `/blocked` command (3 prod files + 2 tests, +455 LOC)
- `74f4d0a` docs — this design doc

Decisions (all architect leans accepted): Q1 `/blocked`; Q2 grouped summary + last 10 titles;
Q3 both; Q4 isolation file `bot/research-audit.js`; Q5 fallback bucket `אחר / לא מסווג`;
Q6 space→underscore normalize (yes); Q7 optional count arg (default 10, clamp 1-100);
Q8 no date filter v1; Q9 silent denial.

QA (Phase 5): GO. 244/244 tests (217 prior + 27 new), zero regression. 23-row fixture smoke
confirmed bucket tally 11/4/4/2/1/1=23, fallback bucket, HTML escaping, null-rationale safety,
⚙️/🤖 legend, message length 1343/4096. Owner-gate verbatim from `/digest_now` (silent denial).
0 STOP-list violations — Hope Filter, `/research`, `/digest_now`, `research-digest.js`,
`articles.js`, the `appendBlocked` call site, and the 3 existing `blocked-log` functions all untouched.

§7 gap #2 cleared: `blocked_at` is a server-default ISO-UTC timestamp; rendered via `formatTimeIL`
(`bot/reminders.js:33`, exported :217), which handles the `Z` suffix and renders in Asia/Jerusalem.

Non-blocking follow-up candidates (not done): verbose IL date format vs the compact `dd/mm` §3 mock
(cosmetic); pagination if the table grows to hundreds (§7 item 8); latent HTML-escaping gap in the
existing `/research` + digest output (STOP-listed here, would be its own ticket).

Live verification pending: `/blocked` round-trip against the live bot + real Supabase row
(owner chat_id 758752313) after the next Render redeploy.
