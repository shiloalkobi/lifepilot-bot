# CRPS-10 — Auto Weekly Digest (Phase A: Design)

**Status:** Investigation only. No source/test changes in this commit.
**Branch:** `feature/crps-10-weekly-digest` (off `main` @ 590b64d).
**Date:** 2026-05-17.
**Goal:** Sunday-morning proactive Telegram message — "מצאתי X מחקרים חדשים השבוע על CRPS" — using the 31 unsurfaced articles already in DB (26 CT.gov + 5 PubMed, verified by Claude via Supabase MCP).

---

## §1 Current State — Findings

### §1.1 How the scheduler works (Task 1)

**Library:** `node-cron` (CommonJS). Two scheduler modules coexist:

| File | Purpose | Timezone pattern |
|------|---------|------------------|
| `bot/scheduler.js` | Daily content (morning 07:00, English 10:00, news 12:00, summary 22:00, weekly Fri 14:00) | UTC cron + manual offset comments |
| `bot/proactive.js` | Behavioral nudges (Friday eve 16:30, health 21:00, weekly plan Sun 08:30, stocks, leads) | `{ timezone: 'Asia/Jerusalem' }` |

**Registration syntax (proactive.js pattern — the one we'll reuse):**
```js
// bot/proactive.js:80 — Sunday 08:30 IL weekly plan
cron.schedule('30 5 * * 0', async () => {
  try { /* fetch → format → bot.sendMessage(chatId, msg) */ }
  catch (e) { console.error('[Proactive] weekly error:', e.message); }
}, { timezone: 'Asia/Jerusalem' });
```

Wait — `bot/proactive.js:80` uses `'30 5 * * 0'` with `timezone: 'Asia/Jerusalem'`. The cron expression itself is `30 5` (05:30) but the timezone label is IL — meaning `cron` interprets `05:30` as IL local time. So Sunday 09:00 IL would be `'0 9 * * 0'` with `{ timezone: 'Asia/Jerusalem' }` (NOT `'0 6 * * 0'` with UTC like `scheduler.js` does).

Actually, looking again carefully at `bot/proactive.js:80-82`: the comment says "Cron runs at 05:30 UTC = 08:30 IL". That comment is **misleading** — the cron block ends with `{ timezone: 'Asia/Jerusalem' }` on line 132, which means node-cron interprets the expression in IL time. So `'30 5 * * 0'` IS 05:30 IL, not 08:30 IL. The startup log claims "Sunday 08:30 IL" but the actual cron is 05:30 IL.

**Honest gap:** The existing Sunday job appears to fire at 05:30 IL, not 08:30 IL as the comment claims. This is a pre-existing bug — out of scope for CRPS-10 but worth flagging. Our digest will use unambiguous `'0 9 * * 0'` + `{ timezone: 'Asia/Jerusalem' }` for 09:00 IL.

**Shabbat interaction with scheduled jobs:**
- `bot/shabbat.js:34-42` defines `isShabbat()` (rough Fri 17:00 → Sat 21:00 IL) and `isShabbatPrecise()` (uses Hebcal candle/havdalah window when set).
- `isShabbatPrecise()` is consulted in **exactly one place**: `bot/telegram.js:619` — gating **incoming** user messages, not outgoing scheduled sends.
- **No outgoing scheduled job currently checks Shabbat.** The Friday 16:30 eve message at `bot/proactive.js:20` fires *before* candles intentionally, and the 21:00 daily health reminder fires regardless of Shabbat state on Friday/Saturday (a pre-existing soft-bug; not our scope).
- For Sunday 09:00 IL: Shabbat is over (Havdalah ~Saturday 21:00 IL), so this is moot. We can add a defensive `if (isShabbatPrecise()) return;` as belt-and-suspenders, but it's not load-bearing.

**Timezone:** Asia/Jerusalem is mandatory project-wide (CLAUDE.md). Both `bot/proactive.js` and `bot/scheduler.js` handle this — proactive.js via the `timezone` option (cleaner), scheduler.js via UTC offset (older pattern).

### §1.2 How research surfacing works (Task 2)

**Flow (per `skills/research/index.js:150` `searchResearch()`):**
1. `profile.ensureProfile(chatId)` — lazy-create.
2. `store.findFreshUnseen(chatId)` — see below.
3. If `<5` articles, fetch from PubMed/CT.gov/medRxiv adapters, classify (Hope Filter → Tier 1/2/3), upsert Tier 1/2, log Tier 3 to blocked_log.
4. `rankArticles()` → `pickTop5()` (3× Tier-1 + 2× Tier-2 target).
5. **For each surfaced article: `store.markSurfaced(id, chatId)`** (`skills/research/index.js:232-237`).
6. Disclaimer attached on first call (one-shot per chat).

**`findFreshUnseen` query (`skills/research/storage/articles.js:63-80`):**
```js
.from('research_articles')
.select('*')
.gte('fetched_at', since)                                    // ← 6h freshness gate
.in('tier', [1, 2])
.or(`surfaced_to_chat_id.is.null,surfaced_to_chat_id.neq.${chatId}`)
.order('tier').order('published_at').limit(50);
```

**Critical observation for digest:** The 6h `fetched_at` filter means `findFreshUnseen` will NOT return the 31 unsurfaced articles in DB if they were fetched >6h ago. We need a sibling function `findUnsurfaced(chatId, limit)` without the `fetched_at` gate. (Existing function untouched — STOP-list compliance.)

**`markSurfaced` (`skills/research/storage/articles.js:82-92`):**
```js
.from('research_articles').update({
  surfaced_to_chat_id: chatId,
  surfaced_at: new Date().toISOString(),
}).eq('id', id);
```
Idempotent at the row level — re-calling for the same id rewrites the same fields. Safe to call from digest.

**Hebrew formatting lives in `bot/telegram.js:595-604` (NOT in the skill).** The skill returns structured `{tier, title_he, summary_he, url, source, …}`; the consumer formats. Pattern:
```
🔬 <b>מחקר CRPS</b> (N מאמרים, סוננו M)

1. {title_he}
   <i>{summary_he}</i>
   <a href="{url}">{source}</a>

…

{disclaimer_he}
```
The digest will compose its own Hebrew shell ("מצאתי X מחקרים חדשים השבוע") but reuse the same per-article block.

### §1.3 How proactive sends work (Task 3)

**Call site:** `bot/index.js:66-74`:
```js
const proactiveChatId = process.env.TELEGRAM_CHAT_ID || mainChatId;
if (proactiveChatId) startProactiveScheduler(bot, proactiveChatId);
```

**chat_id source:** `process.env.TELEGRAM_CHAT_ID` (owner = Shilo = 758752313). Falls back to `mainChatId = process.env.ALERT_CHAT_ID || process.env.CHAT_ID` (`bot/index.js:47`).

**Send pattern (proactive.js:60, 72, 127):**
```js
await bot.sendMessage(chatId, msg);                       // plain
await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' }); // for rich format
```
The `bot` object is the `node-telegram-bot-api` instance from `bot/telegram.js:startBot()`.

**Error contract:** Catch internally, `console.error('[Proactive] X error:', e.message)`, optionally send a degraded fallback message. Never throw out of the cron callback (node-cron will swallow but log noisily).

---

## §2 Design Decision Questions (Q1–Q7)

Numbered for Shilo to answer before implementation.

### Q1 — Day + time?
**Proposed:** Sunday 09:00 IL.
**Why:** After Havdalah (Saturday ~21:00 IL); start of the Israeli work week; before the existing Sunday 05:30 weekly-plan job has any practical overlap (different content, different hour).
**Alternative:** Sunday 10:00 IL if 09:00 feels too early.

### Q2 — How many articles per digest?
**Proposed:** Top 5 unsurfaced, Tier 1 prioritized (same `pickTop5` shape as `/research`: 3× Tier-1 + 2× Tier-2 with fallback).
**Why:** Matches the existing user mental model; avoids inbox fatigue.
**Alternative:** Top 3 (tighter), or Top 10 (encyclopedic — probably too much for a weekly nudge).

### Q3 — What if 0 new articles that week?
**Proposed:** Skip silently (no message at all).
**Why:** A "nothing to report" message trains the user to ignore the digest. Silence preserves signal.
**Alternative:** Send "אין מחקרים חדשים השבוע — המאגר מעודכן ✓" (1 line, low cost, confirms the job is alive).

### Q4 — Trigger a fresh fetch first, or use only existing DB?
**Proposed:** Use only existing DB (no fresh fetch).
**Why:** The DB already has 31 unsurfaced articles — months of backlog. A fresh fetch adds 10–20s latency, ~3 API calls, classifier LLM cost, and would surface duplicates of what's already cached. The first ~6 digests can run purely off the existing backlog.
**Alternative:** Fetch first, then pick — keeps the digest "fresh" but burns API budget weekly even when the backlog is rich. Reconsider if the backlog runs dry in 2–3 months.

### Q5 — Mark articles as surfaced?
**Proposed:** Yes — call `markSurfaced(id, chatId)` for each article in the digest.
**Why:** Otherwise `/research` will resurface them within the 6h cache window, and the next week's digest will re-pick them. Idempotent and the table already supports it.
**Alternative:** No — keep the digest as a "preview" and require `/research` to mark. Worse UX (duplicates).

### Q6 — Respect Shabbat?
**Proposed:** Yes (defensive `if (isShabbatPrecise()) return;` at the top of the handler), even though Sunday 09:00 IL is post-Havdalah.
**Why:** Cheap (1 line), survives a future change in trigger time, mirrors the project's documented Shabbat-respect posture.
**Alternative:** Skip the check (Sunday is always safe). Defensible — but Shilo prefers explicit safety.

### Q7 — Reuse `search_research` internals or write a dedicated digest function?
**Proposed:** Dedicated thin wrapper.
**Why (STOP-list compliance):** Zero touch to `search_research`, the `/research` slash handler, classifier, or Hope Filter. The digest only needs: (a) "give me up to 5 unsurfaced Tier-1/2 articles" and (b) the same per-article Hebrew formatter the slash handler uses. We can lift the formatter into a small shared helper OR duplicate the ~10 lines — both keep `/research` byte-identical.
**Alternative:** Add a `mode: 'digest'` arg to `search_research`. Rejected — couples two flows that should remain independent.

---

## §3 Proposed Architecture — Minimal-Surface Plan

### Files touched (3 total)

| File | Action | Est. LOC delta |
|------|--------|----------------|
| `bot/proactive.js` | Add 1 new `cron.schedule(...)` block at the bottom + import the digest builder | **+~12** |
| `bot/research-digest.js` | **NEW** — `buildDigestMessage(chatId)` builder + `sendWeeklyDigest(bot, chatId)` send wrapper | **+~80** |
| `skills/research/storage/articles.js` | Add new exported function `findUnsurfaced(chatId, limit)` (no `fetched_at` filter; otherwise same shape as `findFreshUnseen`) | **+~22** |

**Total: ~114 LOC added, 0 LOC modified.**

### Files explicitly NOT touched (STOP-list)

- ❌ `skills/research/index.js` — `searchResearch`, `pickTop5`, `rankArticles` untouched.
- ❌ `bot/telegram.js` `/research` slash handler (lines 586–609) untouched.
- ❌ `skills/research/filter/*` (Hope Filter, classifier, tiers, keywords) untouched.
- ❌ `bot/agent.js` CORE/EXTENDED tools untouched.
- ❌ `bot/scheduler.js` untouched (digest is behavioral → proactive.js is the right home).
- ❌ Supabase schema (`research_articles` table) untouched — we only read existing columns.

### Sketch — the 3 additions

**`skills/research/storage/articles.js` — new function (sibling to `findFreshUnseen`):**
```js
async function findUnsurfaced(chatId, limit = 50, client = null) {
  const c = getClient(client);
  const { data, error } = await c
    .from(TABLE)
    .select('*')
    .in('tier', [1, 2])
    .or(`surfaced_to_chat_id.is.null,surfaced_to_chat_id.neq.${chatId}`)
    .order('tier', { ascending: true })
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(`findUnsurfaced failed: ${error.message}`);
  return data || [];
}
```

**`bot/research-digest.js` — NEW file:**
```js
'use strict';
const articlesStore = require('../skills/research/storage/articles');
// reuse the same ranking/picking as /research (read-only require)
const { _internals } = require('../skills/research');
const { rankArticles, pickTop5, maybePrefixFlag } = _internals;

async function buildDigestMessage(chatId) {
  const candidates = await articlesStore.findUnsurfaced(chatId, 50);
  if (candidates.length === 0) return { message: null, articleIds: [] };
  const ranked = rankArticles(candidates);
  const top    = pickTop5(ranked);
  const header = `🔬 <b>מחקרי CRPS השבוע</b> — מצאתי ${top.length} מאמרים חדשים`;
  const items  = top.map((a, i) => {
    const lines = [`${i + 1}. ${maybePrefixFlag(a)}`];
    if (a.framing_he) lines.push(`   <i>${a.framing_he}</i>`);
    lines.push(`   <a href="${a.url}">${a.source}</a>`);
    return lines.join('\n');
  });
  return {
    message: `${header}\n\n${items.join('\n\n')}`,
    articleIds: top.map(a => a.id).filter(Boolean),
  };
}

async function sendWeeklyDigest(bot, chatId) {
  const { isShabbatPrecise } = require('./shabbat');
  if (isShabbatPrecise()) {                       // Q6 defensive
    console.log('[Digest] Shabbat — skipping');
    return;
  }
  const { message, articleIds } = await buildDigestMessage(chatId);
  if (!message) {                                  // Q3 silent-skip
    console.log('[Digest] 0 unsurfaced articles — skipping');
    return;
  }
  await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  // Q5 — mark surfaced AFTER successful send
  for (const id of articleIds) {
    try { await articlesStore.markSurfaced(id, chatId); }
    catch (e) { console.warn(`[Digest] markSurfaced failed for ${id}: ${e.message}`); }
  }
  console.log(`[Digest] Sent ${articleIds.length} articles, marked surfaced`);
}

module.exports = { buildDigestMessage, sendWeeklyDigest };
```

**`bot/proactive.js` — 1 new cron block + 1 import:**
```js
const { sendWeeklyDigest } = require('./research-digest');
// …
cron.schedule('0 9 * * 0', async () => {
  try { await sendWeeklyDigest(bot, chatId); }
  catch (e) { console.error('[Proactive] digest error:', e.message); }
}, { timezone: 'Asia/Jerusalem' });
```

---

## §4 STOP-list for this feature

1. ❌ No schema change to `research_articles` (no new columns; only existing `surfaced_at`, `surfaced_to_chat_id`, `tier`).
2. ❌ No change to existing `search_research` tool logic in `skills/research/index.js`.
3. ❌ No change to the `/research` slash handler in `bot/telegram.js:586-609`.
4. ❌ No change to Hope Filter (`skills/research/filter/classifier.js`, `tiers.js`, `keywords.js`).
5. ❌ No change to `bot/agent.js` CORE/EXTENDED tool descriptors.
6. ❌ No new npm dependency without explicit approval (we reuse `node-cron`, `@supabase/supabase-js`, `node-telegram-bot-api` — all already in `package.json`).
7. ❌ No change to `bot/scheduler.js` (digest is proactive/behavioral, not content/daily).
8. ❌ No change to the Hebcal Shabbat polling logic in `bot/shabbat.js`.

---

## §5 Test plan

New unit tests in `test/research-digest.test.js` (or wherever the existing research tests live — TBD on first impl pass; mirror the convention):

1. **`buildDigestMessage` — 0 unsurfaced articles:** returns `{ message: null, articleIds: [] }` (silent-skip contract for Q3).
2. **`buildDigestMessage` — exactly 5 unsurfaced articles:** returns header + 5 items, all article ids returned.
3. **`buildDigestMessage` — 8 unsurfaced (3 T1 + 5 T2):** returns top 5 with T1 prioritized (3 T1, 2 T2).
4. **`buildDigestMessage` — 12 unsurfaced (all T2):** still returns 5 (degraded ranking — no T1 available, all T2 by recency).
5. **`buildDigestMessage` — Israeli-recruiting article:** title carries 🇮🇱 prefix (via `maybePrefixFlag`).
6. **`sendWeeklyDigest` — Shabbat overlap:** `isShabbatPrecise()` returns true → `bot.sendMessage` NEVER called, no markSurfaced (Q6).
7. **`sendWeeklyDigest` — markSurfaced idempotency:** running twice in a row with the same backlog → first call surfaces 5, second call returns silent-skip (the first call's `markSurfaced` removes them from the pool).
8. **`sendWeeklyDigest` — sendMessage throws:** markSurfaced is NOT called (don't burn the backlog on a failed send). *This requires sequencing the markSurfaced after `await bot.sendMessage(...)` resolves — already in the sketch.*
9. **`findUnsurfaced` — chat A surfaces an article, chat B query:** still returns it (the `surfaced_to_chat_id != chatB` condition).
10. **`findUnsurfaced` — Tier 3 article in DB:** never returned (tier filter `[1, 2]`).

Hand-test (post-implementation):
- Set `FORCE_DIGEST=1` env (or add a `/digest_now` admin slash) to fire `sendWeeklyDigest(bot, OWNER_CHAT)` synchronously; verify message lands in Telegram.
- Re-run; verify silent-skip (since previous run marked everything surfaced).
- Run `/research` next; verify it does NOT show the same articles (because surfacing took effect cross-flow).

---

## §6 Honest gaps / risks

1. **Render free tier cron drift.** node-cron runs in-process. If Render kills the dyno (free tier sleeps after 15 min idle), Sunday 09:00 may not fire. **Mitigation:** Render keep-alive ping already exists (check `bot/index.js` startup logs); if not, this is a separate infra concern out of CRPS-10 scope. **Honest:** I haven't verified the keep-alive — flag for Shilo to confirm.

2. **Duplicate sends on redeploy.** If Render redeploys at 09:00:30 IL Sunday, a new process starts, registers cron, and could fire the missed slot OR fire twice if both processes briefly overlap. **Mitigation:** node-cron does NOT re-fire missed slots (it only runs forward), so a redeploy at 09:00:30 misses the 09:00 fire entirely. Acceptable — weekly digest skipping one week is low cost; double-send is worse than skip.

3. **Timezone DST drift.** Israel observes DST (last Friday in March → last Sunday in October). node-cron's `timezone: 'Asia/Jerusalem'` handles this via the `tz`/IANA database — verified at runtime by examining `bot/proactive.js` which has used this pattern in production. **No action needed**, but flag for Shilo's awareness.

4. **The existing "Sunday 08:30 weekly plan" cron is actually 05:30 IL** (see §1.1) — pre-existing comment/log mismatch. Our digest at 09:00 IL is **3.5 hours after** the actual existing job, so no overlap. If Shilo wants to fix the existing job's time, that's a separate ticket.

5. **31 unsurfaced backlog burns down at 5/week → ~6 weeks of digest content** before the backlog runs dry. Q4 says "use only existing DB" — by week 7, digests will silently skip (Q3) unless `/research` calls have added new articles in the interim. **Reasonable to revisit Q4 in ~5 weeks**, not now.

6. **`_internals` cross-module import** (`bot/research-digest.js` requires `skills/research/index.js._internals.rankArticles`) creates a soft coupling. The internals are documented in `skills/research/index.js:386-399` as "exposed for testing only" — using them from the digest is a slight contract stretch. **Alternative:** copy `rankArticles`/`pickTop5`/`maybePrefixFlag` into `research-digest.js` (~25 LOC duplication). Lean toward the `_internals` import to keep ranking logic single-sourced; if Shilo prefers duplication, easy to switch.

7. **`bot/agent.js` agent-routable digest tool — out of scope for CRPS-10.** Not adding a `send_research_digest` tool means Shilo can't say "שלח לי דיגסט עכשיו" in natural language. If desired later, that's a separate ~10 LOC addition (one tool descriptor + execute dispatch); explicitly NOT in this design.

8. **No new error-telemetry to Render logs beyond `console.error`** — matches existing proactive.js convention. If we later want a dashboard counter for digest success/skip/error, that's a future enhancement.

---

## §7 Next step

Shilo answers Q1–Q7. On approval, Phase B implementation will:
- Make the 3 file additions in §3.
- Add the tests in §5.
- Open a PR on `feature/crps-10-weekly-digest`.
- Hand-test via `/digest_now` (or similar) before merging.
- Update `docs/research/01h-weekly-digest-design.md` with final answers + any deviations from this design.

**Until Q1–Q7 are answered: zero code changes.**
