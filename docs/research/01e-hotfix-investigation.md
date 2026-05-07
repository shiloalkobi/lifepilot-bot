# 01e — Hotfix Investigation (Phase 4f.3)

**Author:** Amelia
**Date:** 2026-05-07
**Mode:** INVESTIGATION (read-only — no code edits in Task 1)
**Branch:** `hotfix/4f3-rls-chat-id-routing` (off main `3d524fd`)
**Trigger:** Shilo's Phase 4f.2 manual smoke surfaced 3 production bugs after the merge to main + Render deploy.

> **Status:** investigation complete. No code touched yet. Awaiting Shilo's fix-plan approval before Tasks 2/3/4 (one commit per bug).

---

## §1 — Bug 1 investigation: RLS/GRANT denying service_role

### Symptom

```
[research] search_research error: getProfile failed: permission denied for table research_user_profile
```

### Diagnostic provided by Shilo (via Supabase MCP)

All 11 tables have **identical** state — `rls_enabled=true`, `force_rls=true`, `policy_count=0`. Yet `tasks`/`expenses`/etc. work for service_role; `research_*` get denied.

### Critical re-classification of the symptom

PostgreSQL error code **42501** (`insufficient_privilege`) with message `"permission denied for table X"` is **NOT an RLS-policy filter** — it's a **GRANT-layer failure**.

The two layers behave differently:

| Failure | Code | Message | Returned data |
|---|---|---|---|
| Missing GRANT | 42501 | `permission denied for table X` | Error response, **0 rows fetched** |
| RLS filter (FORCE+0 policies) | — | (no error) | HTTP 200 with empty array `[]` |

The error Shilo sees is **GRANT-layer**, not RLS. The brief's three options (A: add policies, B: NO FORCE, C: investigate) all assumed RLS. **The actual root cause is missing table-level grants on the 4 research_* tables.**

### Evidence: storage code uses the same client as tasks/expenses

| File | Line | Client source |
|---|---|---|
| `bot/tasks.js` | 5 | `const { supabase } = require('./supabase');` |
| `bot/expenses.js` | 6 | `const { supabase } = require('./supabase');` |
| `skills/research/storage/profile.js` | 17 | `const { supabase: defaultClient } = require('../../../bot/supabase');` |
| `skills/research/storage/articles.js` | 17 | same |

**They all share the exact same `supabase` client from `bot/supabase.js:14`.** No code-level difference in client construction or auth.

`bot/supabase.js:9-10`:
```js
const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const ROLE         = SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon';
```

On Render with `SUPABASE_SERVICE_ROLE_KEY` set → role is `service_role`.

### Hypothesis (high confidence, untested but well-supported)

The 7 working tables (`tasks`, `expenses`, `health_logs`, `habits`, `memory`, `watchlist`, `leads`) were created via Supabase's standard tooling (Studio UI / dashboard SQL editor with default-grant boilerplate, OR migrations during initial project setup). These flows auto-add:
```sql
GRANT ALL ON public.<table> TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
```

The 4 research_* tables were created in Phase 4a via Supabase MCP web-chat — likely with bare `CREATE TABLE` + `ALTER TABLE ENABLE/FORCE RLS` and **no GRANT statements**. PostgreSQL's default is that newly-created tables grant access only to the table owner, NOT to the `service_role` PostgreSQL role that the JWT remaps onto.

So when the bot's `service_role`-keyed client queries `research_user_profile`, PostgREST → PostgreSQL → permission check fails at the GRANT layer (step 2), never reaching RLS evaluation (step 4).

### Diagnostic to confirm (Shilo runs via Supabase MCP)

```sql
SELECT grantee, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'service_role'
  AND table_name IN ('tasks', 'expenses', 'research_articles', 'research_user_profile',
                     'research_topics', 'research_blocked_log')
GROUP BY grantee, table_name
ORDER BY table_name;
```

**Expected if hypothesis correct:**
- `tasks`, `expenses` → rows present with privs like `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE`
- `research_*` → **rows absent** (no grants to service_role)

**If hypothesis wrong:** all 6 tables show grants → root cause is something more subtle (e.g., schema search_path, RLS interaction with PostgREST anon→service_role role-switching). Re-investigate.

### Proposed fix (Bug 1)

**Approach:** SQL migration via Supabase MCP web-chat (continuing 4a pattern). NO bot/* changes, NO skill changes.

```sql
-- Phase 4f.3 Bug 1 fix: align research_* table grants with the project's
-- existing PHI-table pattern (tasks, expenses, etc.). FORCE RLS stays on;
-- 0-policy state stays unchanged. Only the GRANT layer is fixed.

GRANT ALL PRIVILEGES ON TABLE public.research_articles      TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.research_topics        TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.research_blocked_log   TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.research_user_profile  TO service_role;

-- Sequences (for any SERIAL/IDENTITY/uuid_generate_v4 etc.):
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
```

### Re-verify after fix (V57 must still pass)

Per Hard Constraint #7: **anon must STILL be blocked** after the GRANT to service_role lands. The 8 anon curl tests from V57 (4 tables × {SELECT, INSERT}) must all still return HTTP 401 with code 42501. Adding GRANTs to `service_role` does NOT grant to `anon` — they're separate roles. But re-verify to be safe.

### Honest gap noted

This bug ships because Phase 4d's live integration test (4d.G1) was deferred to 4f.2. The unit tests passed because they inject a mock supabase client via the `client` parameter (e.g., `getProfile(chatId, client)` → `getClient(injected)` → uses the mock instead of the shared client). So the GRANT issue was 100% invisible to unit tests.

**Lesson for future BMAD phases:** when storage code uses an injectable mock pattern, the deferred live integration test is the ONLY thing that catches grant/RLS misconfig. Deferring it = deferring this entire class of bug discovery.

---

## §2 — Bug 2 investigation: chat_id naming mismatch (camelCase vs snake_case)

### Symptom

```
[research] get_research_history error: chat_id missing
```

Then Gemini hallucinated 3 fake articles (Bug 4 — see §4 for hallucination analysis).

### Trace through the call chain

**Layer 1 — `bot/agent.js:2186`:**
```js
result = await executeAnyTool(toolName, args, { bot, chatId });
```
The agent passes `ctx = { bot, chatId }` (note: **camelCase** `chatId`).

**Layer 2 — `bot/skills-registry.js:112`:**
```js
const result = await skill.execute(toolName, args, ctx);
```
The registry forwards `ctx` unchanged. So the skill receives `ctx = { bot, chatId }`.

**Layer 3 — `skills/research/index.js:337-341`:**
```js
function resolveChatId(ctx, args) {
  if (ctx && (ctx.chat_id != null)) return ctx.chat_id;       // ← reads chat_id (snake_case)
  if (args && (args.chat_id != null)) return args.chat_id;    // ← also snake_case
  return null;
}
```
**The skill expects `ctx.chat_id` (snake_case) but the agent passes `ctx.chatId` (camelCase).** `ctx.chat_id` is undefined → falls through to args check → also undefined → returns `null` → `searchResearch`/`getHistory`/`subscribeTopic`/`setProfile` all throw `"chat_id missing"`.

### Why unit tests didn't catch it

Unit tests in `tests/research_tools_*.test.js` directly invoke the internal functions (e.g., `_internals.searchResearch(args, ctx, deps)`) with explicit `ctx = { chat_id: 'test-chat' }` (snake_case, matching the skill's contract). They never exercise the agent → registry → skill path with the agent's actual `{ bot, chatId }` shape.

The /research slash handler added in 4e.5 (`bot/telegram.js:583`) DOES match the skill's snake_case contract:
```js
await research.execute('search_research', {}, { chat_id: msg.chat.id });
```

So the slash handler works (one call site Shilo confirmed), and the agent path doesn't (the second call site, surfaced by RT04 `תראה לי היסטוריית מחקר`).

### Proposed fix (Bug 2)

**Approach:** widen `resolveChatId` in `skills/research/index.js` to accept both naming conventions. **Skill-only change, no bot/\* edit.** Per Hard Constraint #2 (Q2 approved: skill-only first).

**File:** `skills/research/index.js` lines 337-341
**Change:** ~3-line edit

```js
function resolveChatId(ctx, args) {
  // Accept both naming conventions:
  //  • ctx.chatId   — bot/agent.js:2186 contract (camelCase)
  //  • ctx.chat_id  — bot/telegram.js:583 /research slash handler (snake_case)
  //  • args.chat_id — explicit override (e.g., admin tooling)
  if (ctx  && ctx.chatId  != null) return ctx.chatId;
  if (ctx  && ctx.chat_id != null) return ctx.chat_id;
  if (args && args.chat_id != null) return args.chat_id;
  return null;
}
```

### Regression test for the fix

Add to a new file `tests/research_chat_id_resolution.test.js` (or extend an existing test) — not strictly required by Hard Constraints, but advisable per Q2 implicit "add unit test to prevent regression":

```js
test('execute() picks chat_id from ctx.chatId (agent contract)', async () => {
  const result = await research.execute('get_research_history', {}, { chatId: 'abc' });
  // result must be a string; if it parses to JSON, ok must be true
});
test('execute() picks chat_id from ctx.chat_id (slash-handler contract)', ...);
```

### Why bot/agent.js change rejected

Per Hard Constraint #5: STOP if any fix requires `bot/agent.js` mod. The skill-side fix is sufficient and preserves both call sites. No need to escalate.

---

## §3 — Bug 3 investigation: free-text routes to `get_news` instead of `search_research`

### Symptom

```
[Agent] START: מחקר חדש על CRPS
[Agent] Tool: get_news {"category":"crps"}    ← WRONG TOOL
```

### Tool description comparison

**`get_news`** (`bot/agent.js:304`, full string):
> `הבא חדשות אישיות. ללא קטגוריה→all. "חדשות AI"→ai, "שוק"→market, "ישראל"→israel, "קריפטו"→crypto, "CRPS"→crps.`

The description has an **explicit string-to-category mapping** that includes `"CRPS"→crps`. This is a strong signal to the model to dispatch `get_news` whenever the user mentions CRPS.

**`search_research`** (`skills/research/index.js:41`):
> `מחקר CRPS מסונן רגשית. כותרת/נושא/רענון.`

Generic and short. Mentions "מחקר" (research) and "CRPS" but with no anti-news disambiguation.

### Why Gemini picked `get_news`

The user message **`מחקר חדש על CRPS`** decomposes as:
- `מחקר` (research) — favors `search_research`
- `חדש` (new) — neutral; could be "new research" or "newest news"
- `על` (about/on) — neutral
- `CRPS` — present in BOTH descriptions

`get_news` has the explicit `"CRPS"→crps` mapping, which is a **categorical signal** that's more decisive than `search_research`'s vague reference. Gemini chose the more specific tool. From a tool-selection-behavior standpoint, this is rational — Gemini followed the more explicit instruction.

### Proposed fix (Bug 3)

**Approach:** sharpen `search_research` description. Don't touch `get_news` (Hard Constraint #5 — `bot/agent.js` is off-limits).

**File:** `skills/research/index.js:41`
**Change:** description string only.

**Constraint to respect:** CLAUDE.md notes "Groq 100K/day → tool descriptions מקוצרות ל-15 מילים מקסימום" — so the new description must stay short.

**Proposed new description (~13 Hebrew words):**

> `מחקר רפואי מדעי על CRPS - PubMed/ClinicalTrials/medRxiv. עבור "מחקר", "מאמר", "trial", "ניסוי קליני". לא לחדשות.`

Why this should win:
- Lists the **canonical research keywords** explicitly (מחקר, מאמר, trial, ניסוי קליני)
- Names the **scientific sources** (PubMed/ClinicalTrials/medRxiv) — these are unique to research, not news
- **`לא לחדשות`** ("not for news") — explicit anti-instruction; this is the strongest Gemini-routing nudge in the OpenAI tool-selection literature
- Stays inside the 15-word soft cap

### Risk

If Gemini still prefers `get_news` after this change, the next escalation step would be modifying `get_news` description to remove the `"CRPS"→crps` mapping — but that requires `bot/agent.js` change (Hard Constraint #5 escalation). Test in 4f.3 smoke verification.

### Honest gap

The `get_news` description's `"CRPS"→crps` mapping was added in some earlier phase before research existed. It made sense then (CRPS news IS a real category). Now that research is the primary CRPS query path, the news mapping is misaligned. Cleaner long-term fix would be to remove `"CRPS"→crps` from `get_news`, but that's out of scope for 4f.3.

---

## §4 — Hallucination prevention design

### Symptom

```
[Agent] Tool result: [object Object]
[Agent] REPLY: הנה היסטוריית המחקר שלך: [HALLUCINATED 3 fake articles]
```

### Root cause: result coercion via `String(result)`

The chain that produces "[object Object]":

**`skills/research/index.js:345-360` — `execute()` returns an object:**
```js
async function execute(toolName, args = {}, ctx = {}) {
  try { ... return await getHistory(args, ctx); }     // returns { ok, articles: [...] }
  catch (err) {
    return { ok: false, error: `${toolName} failed: ${err.message}` };  // OBJECT
  }
}
```

**`bot/skills-registry.js:114`:**
```js
return String(result ?? '');  // ← Object → "[object Object]"
```

**`bot/agent.js:2192`:**
```js
return { role: 'tool', tool_call_id: tc.id, content: String(result) };  // content="[object Object]"
```

The agent's tool message to Gemini contains `content: "[object Object]"`. Gemini receives a useless string and **fabricates** plausible content (3 fake research articles) to satisfy the user's request, because it has no signal that the tool errored.

### Why this is unique to the research skill

The built-in tools in `bot/agent.js` (e.g., `get_tasks` at line 514) **return strings directly**:
```js
return tasks.map((t, i) => `${i + 1}. [${t.priority}] ${t.text}`).join('\n');
```

So when `String(result)` runs, it's a no-op. The contract that `executeAnyTool` enforces (`String(result ?? '')`) was designed assuming string returns. Our skill returning an object violates that implicit contract.

### Two intertwined fixes

**Fix 4a — Make `execute()` return strings (matches built-in contract):**

`skills/research/index.js:345-360` — wrap returns in `JSON.stringify`:

```js
async function execute(toolName, args = {}, ctx = {}) {
  try {
    let result;
    switch (toolName) {
      case 'search_research':          result = await searchResearch(args, ctx); break;
      case 'subscribe_research_topic': result = await subscribeTopic(args, ctx); break;
      case 'get_research_history':     result = await getHistory(args, ctx); break;
      case 'set_research_profile':     result = await setProfile(args, ctx); break;
      default:
        result = { ok: false, error: `Unknown tool "${toolName}" in skill "${name}"` };
    }
    return JSON.stringify(result);
  } catch (err) {
    console.error(`[research] ${toolName} error: ${err.message}`);
    return JSON.stringify({
      ok: false,
      error: `${toolName} failed: ${err.message}`,
      articles: [],
      _do_not_fabricate: true,
      _instruction_to_assistant:
        'Tool returned an error. Tell the user the operation failed; do NOT make up articles or any other data.',
    });
  }
}
```

**Fix 4b — Make error responses structurally unmistakable** (already in fix 4a's catch block):
- `articles: []` — empty list for tools that surface articles, so even a clueless model can't pretend success
- `_do_not_fabricate: true` — flag the model can read in the JSON
- `_instruction_to_assistant` — explicit instruction the model SHOULD follow per Gemini's tool-message conventions

### Why this lands in the Bug 2 commit

Per the brief, hallucination prevention is "part of Bug 2 fix." The `chat_id missing` error from Bug 2 is exactly what triggers the catch block in `execute()`. Fixing Bug 2 without fixing the result format would still leave the door open for any future error to fabricate. So Fix 2 + Fix 4 land together as **one commit** with title `fix(research): Bug 2 — chat_id flow + JSON-string error envelope`.

### Acceptance criteria

After fix, re-run a forced-error case (e.g., revert chat_id resolution temporarily, or call execute() with no ctx). Expected agent log:
```
[Agent] Tool result: {"ok":false,"error":"...","articles":[],"_do_not_fabricate":true,...}
```
Then: agent reply must surface "an error occurred" rather than fabricated articles.

---

## §5 — Proposed fix plan (consolidated)

| Bug | File | Lines | Type | Net diff | Migration? |
|---|---|---|---|---|---|
| 1 | (no source file — SQL migration via Supabase MCP) | n/a | GRANT | ~5 SQL lines | **YES** — Supabase MCP web-chat |
| 2 + 4 | `skills/research/index.js` | 337-341 (resolveChatId) + 345-360 (execute) | Code | ~10 LOC | No |
| 3 | `skills/research/index.js` | 41 (search_research description) | Code | 1 LOC | No |

### Order (per Q3 — sequential commits, investigate-once)

1. **Commit A — Bug 1 (RLS/GRANT):** Shilo runs SQL via Supabase MCP. Then I add a 0-LOC code change (just a comment update in `01d` cross-cutting + a new `01e` reference). No source code edit. Branch state unchanged from main + this commit will be the SQL migration record.
2. **Commit B — Bug 2 + Bug 4:** edit `resolveChatId` AND `execute()` in `skills/research/index.js`. Add regression test.
3. **Commit C — Bug 3:** edit `search_research` description in `skills/research/index.js:41`. 1 LOC.

After all 3: merge `hotfix/4f3-rls-chat-id-routing` → `main` with `--no-ff` (one Render redeploy event).

### Bot/* impact

**ZERO.** All 3 fixes stay outside `bot/*` (Hard Constraints #2 + #5). The branch ends with `bot/*` byte-identical to its state after merge `435a7d6` (`bot/telegram.js` +24, `bot/backup.js` +1, all others = main pre-merge).

### Test impact

- Existing 185 unit tests: must continue 185/185 PASS after each commit
- New regression test for Bug 2: 1-2 new test cases (chat_id flows from both `chatId` and `chat_id`)
- New regression test for Bug 4 (optional): 1 case forcing an error and asserting JSON-string error shape
- V57 (8 RLS curl probes): re-run after Bug 1 fix lands; must still 8/8 block at HTTP 401

---

## §6 — STOP-list re-evaluation

Investigation phase only — no source files touched. Nothing in this doc activates a STOP trigger.

| # | Trigger | Activated by 4f.3 (planned)? | Reasoning |
|---|---|---|---|
| 1 | Schema change to existing table | ❌ no | Bug 1 fix is GRANT only, not schema |
| 2 | Change to existing loader/routing mechanism | ❌ no | resolveChatId is internal; routing in agent untouched |
| 3 | `@supabase/supabase-js` upgrade | ❌ no | dep unchanged |
| 4 | Bot main system prompt change | ❌ no | unchanged |
| 5 | Cron job addition | ❌ no | none |
| 6 | `bot/supabase.js` change | ❌ no | unchanged |
| 7 | `bot/agent.js` CORE/EXTENDED change | ❌ no | unchanged |

**0/7 STOP-list triggers expected.** The skill description tweak (Bug 3) is not a "loader/routing change" — it's a tool-description text edit, which is the established pattern for skill tuning.

---

## §7 — Time spent on investigation

**~25 minutes** (5 file reads + agent.js spot-reads + this doc).

Investigation was bounded because:
- The diagnostic Shilo ran via Supabase MCP narrowed Bug 1 to "not table state, must be code OR grants" — and reading the storage files showed identical client construction, leaving GRANTs as the remaining variable.
- Bug 2 was a 5-line trace (agent → registry → skill) with the bug hiding in 1 word of difference (`chatId` vs `chat_id`).
- Bug 3 was a side-by-side description comparison.
- Bug 4 was discovered during Bug 2 (the `String(result)` coercion).

---

## Open items pending Shilo's approval

1. **Q (Bug 1 verification):** approve the diagnostic SQL in §1 to confirm GRANT hypothesis before applying the fix? Or trust the analysis and apply the GRANT statements directly (low-risk additive change)?
2. **Q (commit ordering):** approve the order Bug 1 → Bug 2+4 → Bug 3?
3. **Q (Bug 1 commit type):** Bug 1's source-code commit will be a doc-only update (since the actual fix is in Supabase). Confirm that's acceptable, or prefer to skip a code-side commit and just add Bug 1 to the merge note?
4. **Q (regression tests):** add new tests for Bug 2 (chat_id resolution) and optionally Bug 4 (JSON-string error envelope)? Both stay in `tests/research_*.test.js` (no new top-level dirs).

---

— Amelia 💻
