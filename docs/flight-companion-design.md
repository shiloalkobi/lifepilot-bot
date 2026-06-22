# Disability Flight Companion — Technical Design (Phase 2, Architect)

Author: Winston (BMAD Architect) · Date: 2026-06-22 · Status: DESIGN — awaiting Shilo's answers to Q1–Q8 before PRD/impl
Scope owner: שילה אלקובי (wheelchair user, CRPS, owner-only feature)

> This is a design document only. No implementation. STOP after Q8 — wait for human answers.

---

## 0. Summary

A new LifePilot skill `skills/flight/` that gives Shilo two things while travelling by air:

- **Part A — Pre-flight prep (static, 0 LLM tokens):** researched HE+EN content delivered via a direct `/flight` command menu — checklist, required docs, wheelchair/battery rules, rights (queue exemption for him + 1 companion, manual screening, 48h airline notice), CRPS security statement, ready-made English phrasebook. Modelled exactly on the proven `/research` direct-execute pattern (`bot/telegram.js:591-614`, `skills/research/index.js:92`).
- **Part B — Live help (≤1 Gemini call/note):** Shilo records a Telegram voice note of airline staff (English) → bot transcribes **verbatim** + translates to **Hebrew** → returns both. Reuses the existing voice intake plumbing (`bot/telegram.js:726-742`) but routes to a **separate, non-Hebrew-locked** transcribe function so the existing Hebrew voice UX (`skills/voice/index.js:38-55`) is never touched.

Hard rules honoured: info + translation only (no booking/check-in/action); rights/medical output always carries a baked-in HE+EN disclaimer; lean reuse; static = 0 tokens, voice = ≤1 Gemini call; existing Hebrew voice UX untouched.

---

## 1. Architecture overview

### 1.1 New files (minimal surface)

| File | New/Edit | Purpose | LOC est. |
|------|----------|---------|----------|
| `skills/flight/index.js` | NEW | Skill module: exports `{ name, description, tools:[], execute, transcribeFlightVoice }`. Holds Part A content constants + Part A `execute('flight_section',…)` + Part B `transcribeFlightVoice()`. | ~220 |
| `skills/flight/content.js` | NEW (optional, see Q3) | If content stays in-code: HE+EN string constants module imported by `index.js`. Keeps `index.js` logic-only. | ~180 |
| `data/flight-companion.json` | NEW (alternative, see Q3) | If content is data-driven: edit-without-deploy JSON source of truth. | ~ data only |
| `bot/telegram.js` | EDIT | (a) Register `/flight` command (one menu, like `/research` at `:591`). (b) Add **flight-mode branch** inside the existing `msg.voice` block at `:726-742`. | ~55 changed |

No other files change. Total new logic ≈ **2 new files + 2 edit sites in 1 existing file**.

### 1.2 How it plugs into existing systems

- **Skill contract / loader:** `skills/flight/index.js` exports the standard `{ name, description, tools, execute }` (skills/README.md:54-89). It declares `tools: []` — exactly like `skills/voice/index.js:13` — so it registers **zero agent tools** and consumes **zero ReAct/LLM budget**. Custom functions (`transcribeFlightVoice`, Part A `execute`) are `require()`-d directly from `bot/telegram.js`, the same way `transcribeVoice` is required at `bot/telegram.js:729`. Confirmed safe against the loader at `bot/skills-registry.js:42-65` (empty `tools` array = no registration, no conflict).
- **Part A integration point:** new `bot.onText(/^\/flight…/)` handler in `bot/telegram.js`, placed next to `/research` (`bot/telegram.js:591-614`). It `require('../skills/flight')`, calls `execute('flight_section', { section }, { chat_id })`, and `sendMessage` with `parse_mode:'HTML'`. Zero LLM tokens — pure string return, identical mechanics to `/research`.
- **Part B integration point:** the existing voice block at `bot/telegram.js:726-742`. We add a routing check (see §3.1) that, in flight mode, calls `transcribeFlightVoice(fileUrl)` instead of `transcribeVoice(fileUrl)`, and sends the verbatim+translation **directly** (bypassing `handleMessage`/the agent) so the airline transcript is never fed to the ReAct loop.
- **Shabbat / Pikud:** the voice block already sits **after** the Shabbat gate (`bot/telegram.js:711-723`), so flight voice notes inherit Shabbat blocking automatically. No change. (Air travel on Shabbat is an edge case; see Q7.)

---

## 2. Part A design — static pre-flight content

### 2.1 Content storage decision

**Recommendation: in-code constants in `skills/flight/content.js` for MVP** (matches the proven `DISCLAIMER_HE` constant pattern at `skills/research/index.js:92`). Rationale: hallucination-proof, quota-proof, version-controlled, reviewable in PR, and the content is small and changes rarely. The "edit without deploy" benefit of JSON is low-value here because deploys are cheap and content edits are infrequent — but this is **Q3** for Shilo to confirm. If he prefers edit-without-deploy, swap to `data/flight-companion.json` loaded with the same shape; the `execute()` surface is identical either way.

### 2.2 Command surface — ONE menu, not many commands

**Recommendation: a single `/flight` command that returns a menu**, with sections selected by a one-word arg or inline keyboard. Avoids polluting the command space with 6 separate commands.

```
/flight              → menu header + section list (HE) + how to use Part B
/flight checklist    → pre-flight checklist (HE+EN)
/flight docs         → required documents (HE+EN)
/flight wheelchair   → wheelchair + battery rules (HE+EN)
/flight rights       → rights: queue exemption (him + 1 companion), manual screening, 48h notice (HE+EN) + DISCLAIMER
/flight security     → CRPS security statement (HE+EN) + DISCLAIMER
/flight phrases      → ready-made English phrases (EN phrase + HE gloss)
```

Regex mirrors the hardened `/research` pattern (`bot/telegram.js:591`): `^/flight(?:@\w+)?(?:\s+(\w+))?$` — accepts `@botname` suffix, captures the optional section word, tolerates trailing whitespace. Unknown/empty section → return the menu. Section can also be offered as an inline keyboard (Telegram `reply_markup`) for tap-not-type; that is **Q6**.

### 2.3 Data shape (`execute` contract)

`execute('flight_section', { section }, ctx)` returns a **JSON string** (matching `/research`'s `typeof raw === 'string' ? JSON.parse` convention at `bot/telegram.js:596`):

```jsonc
{
  "ok": true,
  "section": "rights",
  "title_he": "זכויות בשדה התעופה",
  "title_en": "Airport rights",
  "body_he": "…HE bullet text…",
  "body_en": "…EN bullet text…",
  "needs_disclaimer": true,          // true for rights + security
  "disclaimer_he": "…",              // present iff needs_disclaimer
  "disclaimer_en": "…"               // present iff needs_disclaimer
}
```

For `section: undefined` → `{ ok:true, section:"menu", body_he:"…list…" }`. For unknown section → same menu (graceful).

### 2.4 How the disclaimer is embedded (Part A)

The disclaimer is **a property of the content constant itself**, not appended by the caller. Sections that carry rights/medical claims (`rights`, `security`) define `disclaimer_he` / `disclaimer_en` **inside the constant**. `execute()` returns them; the `/flight` handler appends them unconditionally when `needs_disclaimer === true`. Because the flag and text live in the content module, a section cannot be authored without its disclaimer being co-located and visible in review. See §4 for the guardrail test that enforces this.

Disclaimer text (baked, HE+EN):
- HE: `⚖️ הבהרה: מידע כללי בלבד, לא ייעוץ משפטי/רפואי מחייב. אמת מול חברת התעופה ורשות התעופה לפני הטיסה.`
- EN: `⚖️ Note: general info only, not binding legal/medical advice. Confirm with your airline and the aviation authority before flying.`

---

## 3. Part B design — live voice help

### 3.1 Voice routing solution (resolves OQ1 collision)

The existing handler at `bot/telegram.js:726` forces **every** voice note through Hebrew-locked `transcribeVoice`. We must distinguish a flight-mode note without breaking that.

**Recommendation: a per-session flight-mode flag toggled by command, with an explicit caption fallback.**

- `/flight_on` → sets flight mode ON for this chat (in-memory `Set` of chatIds, or a single boolean since feature is owner-only). Bot replies: "מצב טיסה פעיל — שלח הקלטה ואתרגם מילה במילה. /flight_off לכיבוי."
- `/flight_off` → clears it.
- While ON, the `msg.voice` branch routes to `transcribeFlightVoice` (verbatim+HE translation, sent directly) **instead of** `transcribeVoice`.
- While OFF, behaviour is byte-for-byte identical to today (Hebrew transcribe → agent). **Zero risk to existing UX.**

Why a toggle over alternatives:
- *"Always return original+translation for all notes"* — rejected: changes existing Hebrew UX (violates hard constraint 5) and wastes a translation on Hebrew notes.
- *"Per-note caption keyword"* — Telegram voice notes can't carry a caption in the standard mobile UI, so unreliable as the primary mechanism. Kept only as a **secondary** trigger: if a voice note arrives that is itself a forwarded audio with caption containing `flight`/`טיסה`, treat as flight mode (nice-to-have, can defer).
- The toggle state is ephemeral (process memory). Acceptable: travel sessions are short; on restart Shilo re-sends `/flight_on`. No persistence needed for MVP (Q5 covers whether to persist).

Routing pseudo-shape at `bot/telegram.js:726`:

```
if (msg.voice) {
  if (flightModeOn(chatId)) {
     const { transcribeFlightVoice } = require('../skills/flight');
     const out = await transcribeFlightVoice(fileUrl);   // { transcript_en, translation_he }
     bot.sendMessage(chatId, formatFlight(out));          // direct send, NOT handleMessage
     return;
  }
  // …existing Hebrew path unchanged (lines 729-740)…
}
```

### 3.2 `transcribeFlightVoice()` — design

Lives in `skills/flight/index.js` (NOT in `skills/voice/` — STOP-list protects `transcribeVoice`). It reuses `downloadBuffer` semantics but is an independent function so the Hebrew system instruction is never shared.

- **Input:** `fileUrl` (Telegram file URL, same as `transcribeVoice`).
- **Output:** `{ transcript_verbatim, translation_he, detected_lang }` (object).
- **Model:** `gemini-3-flash-preview` (same model as `skills/voice/index.js:45`), but with a **multilingual** system instruction and a structured prompt requesting two fields. **One** `generateContent` call.
- **How it differs from `transcribeVoice`:**
  - System instruction: NOT Hebrew-locked. Something like *"You are a verbatim multilingual transcription + translation service. Transcribe exactly what is said in its original language, then translate to Hebrew. Do not summarise, do not answer, do not add content."*
  - Prompt asks for a delimited two-part response (verbatim original, then Hebrew translation) — parsed into the two fields. (Whether one call reliably yields both is the **key risk R1, §6.**)
  - Output is **sent directly** to Shilo, never passed to `handleMessage`/the agent — so airline speech can't trigger tools or be "interpreted."
- **Reply format (HE-first, both shown):**
  ```
  🎙️ מקור (verbatim): "<transcript_verbatim>"
  🔁 תרגום: <translation_he>
  ```
  Optional EN-phrase suggestion is **deferred from MVP** (Q4 / §6).

### 3.3 Error / fallback behaviour

- Download fails / Gemini error → `⚠️ לא הצלחתי לתמלל. נסה שוב או דבר לאט יותר.` (mirrors `bot/telegram.js:739`). Flight mode stays ON.
- Empty/garbled transcript → return whatever Gemini gave plus a hint: `(ייתכן שהקול לא היה ברור)`.
- If the two-part parse fails (only one block returned) → show the raw model output under "מקור" and a note that translation could not be separated, rather than dropping content. Verbatim fidelity beats clean formatting.
- Gemini quota exhausted → same error message; Part A still fully works (0-token).

---

## 4. Guardrail design — disclaimer always present

Two layers:

1. **Co-location (authoring):** disclaimer text lives *inside* each rights/medical content object (`needs_disclaimer` + `disclaimer_he/en`), so it can't be authored separately or forgotten in the data.
2. **Test-enforced invariant (CI/QA):** a unit test asserts that **every** section whose key is in a `MEDICAL_LEGAL_SECTIONS` set (`['rights','security']`) returns `needs_disclaimer === true` and non-empty `disclaimer_he` + `disclaimer_en`, AND that the `/flight` handler appends them. This is the concrete mechanism: if someone adds a rights-type section without a disclaimer, the test fails. (No global interceptor exists in the codebase — `skills/research/index.js:239-247` appends conditionally — so we enforce by test, not by runtime middleware, keeping it lean.)

Recommendation: put `needs_disclaimer:true` on `rights`, `security`, and also `wheelchair`/`docs` if they make rule claims — **Q8** asks Shilo which sections count as "rights/medical."

---

## 5. Token & cost analysis

| Surface | LLM calls | Tokens | Notes |
|---------|-----------|--------|-------|
| `/flight` + all Part A sections | 0 | 0 | Pure string constants, like `/research` direct execute. |
| `/flight_on` / `/flight_off` | 0 | 0 | State toggle only. |
| Part B voice note | **1 Gemini call** | ~1 audio + small text out | One `generateContent`, same model as existing voice. Does **not** touch Groq 100K/day budget or `bot/rate-limiter.js`. Never enters the ReAct loop (max 4 rounds), so no multi-round amplification. |
| "Suggest a reply" (deferred) | +1 LLM (if built) | small | Out of MVP scope (Q4). |

Net: feature adds **zero** ongoing background cost. Voice cost is strictly pay-per-use and bounded to 1 call/note. No impact on the 07:00/21:00/Friday proactive schedulers.

---

## 6. Risks & preconditions

- **R1 (HIGH, UNVERIFIED) — single-call verbatim multilingual transcribe+translate.** It is not yet proven that `gemini-3-flash-preview` reliably returns *both* a faithful verbatim original *and* a clean Hebrew translation in one structured response (vs. summarising, or translating only). **Verification plan (impl/QA, before merge):** record 5 sample English airline-style clips → run `transcribeFlightVoice` → manually check (a) verbatim accuracy, (b) translation accuracy, (c) two-field parse success rate. **Fallback if it fails:** split into 2 Gemini calls (call 1 = verbatim transcript with multilingual instruction; call 2 = translate that text to Hebrew). This keeps the design but raises cost to 2 calls/note — still bounded, still no ReAct. The function signature/integration point does not change, so this fallback is an internal swap. Flag in PRD.
- **R2 (MED) — content not in repo (PRECONDITION).** The researched HE+EN content "exists elsewhere" and is **not** in the codebase. Implementation is **blocked** until Shilo supplies the finalised content (checklist, docs, wheelchair/battery rules, rights, CRPS security statement, phrasebook). The architecture is content-agnostic; this is a data dependency, not a design risk — but it gates the build.
- **R3 (LOW) — flight-mode left ON.** If Shilo forgets `/flight_off`, normal Hebrew voice notes get verbatim+translate treatment. Mitigation: `/flight_on` reply states how to turn off; optionally auto-expire flight mode after N hours (Q5).
- **R4 (LOW) — Shabbat + travel.** Voice notes are blocked during Shabbat by the gate above the voice block (`bot/telegram.js:711-723`). If Shilo travels on Shabbat this blocks Part B. Out of scope unless Shilo wants an exception (Q7) — and per project rules, Shabbat blocking is intentional.

---

## 7. STOP-list (carried forward — do NOT touch in impl)

- `skills/research/*` (research stack), generators + the 6 landing templates, the lead pipeline.
- `bot/rate-limiter.js`.
- Health-logging code.
- **`skills/voice/index.js` `transcribeVoice()` and its Hebrew system instruction (`:46`, `:50`)** — flight English+translate MUST be a new separate function (`transcribeFlightVoice`) in `skills/flight/`, never an edit to the Hebrew path.
- The existing Hebrew voice UX: the OFF-mode path through `bot/telegram.js:729-740` → `handleMessage` must remain byte-identical.
- No booking / check-in / action automation of any kind (info + translation only).

---

## 8. Design questions for Shilo (decide before PRD/impl)

**Q1 — Voice routing mechanism.** Use an explicit `/flight_on` ÷ `/flight_off` per-session toggle (recommended), so normal Hebrew voice notes are 100% unchanged and only flight-mode notes get verbatim+translate?
> **Recommendation: YES — toggle.** Safest for existing UX, zero ambiguity.

**Q2 — Direct-send vs agent for Part B.** Confirm flight transcripts are sent **directly** to you (verbatim + Hebrew) and never passed to the agent/ReAct loop (so airline speech can't trigger tools or be "answered")?
> **Recommendation: YES — direct send.** Matches "translation only," saves tokens, prevents misfires.

**Q3 — Part A content storage.** In-code constants in `skills/flight/content.js` (recommended: hallucination-proof, in PR/version control, deploy-to-edit) vs `data/flight-companion.json` (edit-without-deploy)?
> **Recommendation: in-code constants for MVP.** Content changes are rare; correctness/review matters more than no-deploy edits.

**Q4 — "Suggest a reply."** Defer from MVP (recommended) — ship verbatim+translation + on-demand phrasebook first; add an optional 1-LLM-call reply suggester later?
> **Recommendation: DEFER.** It's the only piece needing extra LLM and product judgement.

**Q5 — Flight-mode persistence/expiry.** Keep flight mode in process memory only (cleared on restart) and/or auto-expire after e.g. 3h, vs persist it? 
> **Recommendation: in-memory + auto-expire after a few hours.** Lean, and prevents R3 (stuck-on).

**Q6 — Part A delivery UX.** One `/flight` command with **typed section args** (`/flight rights`), or an **inline-keyboard menu** (tap buttons), or both?
> **Recommendation: both — `/flight` shows an inline keyboard, args still work** for power use. Tapping is easier at an airport.

**Q7 — Shabbat exception.** Should Part B (flight voice) bypass Shabbat blocking when you're actually travelling, like Pikud HaOref alerts do — or keep Shabbat blocking intact (default)?
> **Recommendation: keep Shabbat blocking intact.** Don't carve exceptions unless you confirm you travel on Shabbat.

**Q8 — Which sections carry the binding disclaimer.** Confirm the disclaimer attaches to `rights` and `security` at minimum — do you also want it on `wheelchair`/`docs` (which state airline rules)?
> **Recommendation: rights + security + wheelchair + docs.** Anything that asserts a rule/right gets the HE+EN "confirm with airline/authority" line.

**Q9 (precondition, not a choice) — content delivery.** Implementation is blocked on you supplying the finalised HE+EN content (R2). When can you provide: checklist, required docs, wheelchair/battery rules, rights text, CRPS security statement, English phrasebook?

---

*STOP. Awaiting answers to Q1–Q9 before producing a PRD or any implementation.*
