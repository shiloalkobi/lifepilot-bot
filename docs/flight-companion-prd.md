# Disability Flight Companion — Product Requirements Document (PRD)

Author: John (BMAD PM) · Date: 2026-06-22 · Phase 3 (Requirements)
Owner / sole user: שילה אלקובי (wheelchair user, CRPS, owner-only feature)
Status: **DRAFT FOR APPROVAL** — STOP after this PRD. No implementation until human sign-off AND the R2 content blocker is cleared.

> Built **on top of** the approved Phase 2 architect design: `docs/flight-companion-design.md`. This PRD references that design and MUST NOT contradict it. Where this document says "per design §X" it means the corresponding section of `docs/flight-companion-design.md`. Owner decisions Q1–Q9 (this doc, §10) are LOCKED.

---

## 1. Overview & Goal

### 1.1 What this is
A new owner-only LifePilot skill, `skills/flight/`, that helps Shilo travel by air with a disability. Two parts (per design §0):

- **Part A — Pre-flight prep (static, 0 LLM tokens).** A direct `/flight` command surface that returns researched HE+EN reference content: pre-flight checklist, required documents, wheelchair/battery rules, airport rights (queue exemption for him + 1 companion, manual screening, 48h airline notice), CRPS security statement, and an English phrasebook. Modelled on the proven `/research` direct-execute pattern (`bot/telegram.js:591-614`, `skills/research/index.js`).
- **Part B — Live help (≤1 Gemini call/note).** While in flight mode, Shilo records a Telegram voice note of an English-speaking airport/airline staffer; the bot transcribes it **verbatim** and **translates to Hebrew**, then sends both **directly** back to Shilo — never routed through the agent/ReAct loop. Reuses the existing voice-intake plumbing (`bot/telegram.js:726-742`) but via a **separate** transcribe function so the Hebrew voice UX (`skills/voice/index.js:38-55`) is never touched.

### 1.2 Goal
Reduce Shilo's cognitive load and language friction at airports — give him trustworthy, instantly-available rights/logistics info in Hebrew (Part A) and on-the-spot understanding of what English-speaking staff are telling him (Part B) — **without** any booking/check-in/action automation, and **without** disturbing any existing LifePilot behaviour.

### 1.3 Success criteria
- **S1.** `/flight` and every Part A section return correct HE+EN content with **0 LLM tokens** (pure string constants).
- **S2.** Every rights/medical/rule-asserting section (rights, security, wheelchair, docs — per Q8) carries the baked-in HE+EN disclaimer, enforced by a unit test (per design §4).
- **S3.** A flight-mode voice note returns a **verbatim** English transcript **and** a Hebrew translation, sent directly to Shilo, using **≤1 Gemini call** (≤2 only if the R1 fallback is active).
- **S4.** With flight mode OFF, the existing Hebrew voice path is **byte-identical** to today (`bot/telegram.js:729-740`).
- **S5.** The R1 5-clip verification gate passes (or the documented 2-call fallback is in place) before Part B merges.
- **S6.** New surface is exactly **2 new files + 2 edit sites in `bot/telegram.js`** (per design §1.1) — no other files change.
- **S7.** Feature is reachable only by the owner (`String(chatId) === process.env.TELEGRAM_CHAT_ID`).

---

## 2. Scope

### 2.1 In scope (MVP)
1. `skills/flight/index.js` — skill module exporting `{ name, description, tools: [], execute, transcribeFlightVoice }`. `tools: []` so it registers **zero** agent tools (per design §1.2, mirrors `skills/voice/index.js:13`).
2. `skills/flight/content.js` — in-code HE+EN string constants (Part A content + disclaimers) — **Q3 LOCKED to in-code constants**.
3. `bot/telegram.js` edit site #1 — register `/flight` command surface (menu + sections), beside `/research` (`bot/telegram.js:591`).
4. `bot/telegram.js` edit site #2 — flight-mode branch inside the existing `msg.voice` block (`bot/telegram.js:726-742`).
5. `/flight_on` ÷ `/flight_off` per-session toggle commands (in-memory state) — **Q1 LOCKED**.
6. Part A delivery via **both** inline keyboard (tap) **and** typed args (`/flight rights`) — **Q6 LOCKED**.
7. HE+EN disclaimer co-located inside rights/security/wheelchair/docs content objects — **Q8 LOCKED**.
8. Unit test enforcing the disclaimer invariant (per design §4).
9. R1 verification gate (5-clip manual test) + the documented 2-call fallback path (per design §6).

### 2.2 Out of scope (explicitly)
- **"Suggest a reply" feature — DEFERRED from MVP (Q4 LOCKED).** No reply-suggestion / outbound-phrasing LLM call ships in MVP. (Part A's static phrasebook is the only "what do I say" support in MVP.)
- Any **booking, check-in, seat selection, special-assistance request submission, or action automation** — info + translation ONLY (Hard Constraint 1).
- Any **persistence** of flight-mode state across process restarts (Q5: in-memory only).
- Any **Shabbat exception** for Part B (Q7: Shabbat blocking stays intact).
- Editing, wrapping, or reusing `skills/voice/index.js` `transcribeVoice()` or its Hebrew system instruction (STOP-list, design §7).
- Storing or forwarding airline audio anywhere, or feeding airline speech to the agent/ReAct loop.
- Multi-user / non-owner access.
- A `data/flight-companion.json` data-driven content source (the design's Q3 alternative is rejected; in-code constants only).

---

## 3. User Stories & Acceptance Criteria

All stories are "As Shilo (the owner)…". Every acceptance criterion (AC) is independently verifiable.

### Epic A — Part A: Pre-flight prep (static content)

#### Story A1 — Open the flight menu
*As Shilo, I want to type `/flight` and get a menu of all pre-flight topics, so I can find what I need at the airport.*
- **A1.1** Sending `/flight` (also `/flight@<botname>`, and with trailing whitespace) returns the menu. Regex follows the hardened `/research` style (per design §2.2): `^/flight(?:@\w+)?(?:\s+(\w+))?$`.
- **A1.2** The menu lists all sections (checklist, docs, wheelchair, rights, security, phrases) in Hebrew, plus a one-line "how to use Part B" note (`/flight_on`).
- **A1.3** The menu is delivered with `parse_mode: 'HTML'` and an inline keyboard whose buttons map to each section (Q6).
- **A1.4** Producing the menu consumes **0 LLM tokens** (verified: no `callLLM`/Gemini/Groq invocation in the `/flight` handler path).
- **A1.5** An **entry log** line is emitted on invocation (mirrors `bot/telegram.js:592`) for observability.

#### Story A2 — Read a section by typed arg
*As Shilo, I want to type `/flight rights` (or any section word) and get that section directly.*
- **A2.1** Each of `checklist`, `docs`, `wheelchair`, `rights`, `security`, `phrases` returns its HE+EN content body.
- **A2.2** `execute('flight_section', { section }, ctx)` returns the JSON-string shape defined in design §2.3; the handler JSON-parses with the `typeof raw === 'string'` guard (mirrors `bot/telegram.js:596`).
- **A2.3** An **unknown** or **empty** section returns the menu gracefully (no error, no crash) — per design §2.3.
- **A2.4** Each section render consumes **0 LLM tokens**.

#### Story A3 — Tap a section from the keyboard
*As Shilo, I want to tap a button instead of typing, because typing at an airport is hard.*
- **A3.1** Tapping an inline-keyboard button renders the same content as the equivalent typed arg (A2.1) — content is byte-identical between tap and type.
- **A3.2** Keyboard handling adds **0 LLM tokens**.
- **A3.3** Tapping a button does not route content through the agent/ReAct loop.

#### Story A4 — Disclaimer always present on rule/right sections
*As Shilo, I need every section that asserts a right or rule to carry the "not binding — confirm with airline/authority" disclaimer, in HE and EN.*
- **A4.1** The set `MEDICAL_LEGAL_SECTIONS = ['rights','security','wheelchair','docs']` (Q8) each return `needs_disclaimer === true` with **non-empty** `disclaimer_he` and `disclaimer_en`.
- **A4.2** Sections **not** in that set (`checklist`, `phrases`) do **not** force the disclaimer.
- **A4.3** The disclaimer text is **co-located inside the content object** (not appended by the caller) per design §2.4; the handler appends it unconditionally when `needs_disclaimer === true`.
- **A4.4** Disclaimer wording matches design §2.4 (HE: "⚖️ הבהרה: מידע כללי בלבד…"; EN: "⚖️ Note: general info only…").
- **A4.5** A **unit test** (the invariant of design §4) fails if any section in `MEDICAL_LEGAL_SECTIONS` is missing `needs_disclaimer === true` or either disclaimer string — see NFR-2 and §5.

### Epic B — Flight-mode toggle

#### Story B1 — Turn flight mode on
*As Shilo, I want `/flight_on` to put the bot into "translate airline speech" mode for my chat.*
- **B1.1** `/flight_on` sets flight mode ON for this chat in **in-memory** state only (no disk/DB persistence) — Q1/Q5.
- **B1.2** The reply tells Shilo mode is on, to send a recording, and how to turn it off (e.g. "מצב טיסה פעיל — שלח הקלטה ואתרגם מילה במילה. /flight_off לכיבוי.") — per design §3.1.
- **B1.3** `/flight_on` consumes **0 LLM tokens**.

#### Story B2 — Turn flight mode off
*As Shilo, I want `/flight_off` to return to normal Hebrew voice behaviour.*
- **B2.1** `/flight_off` clears flight mode for this chat; reply confirms.
- **B2.2** After `/flight_off`, a voice note follows the **byte-identical** existing Hebrew path (`bot/telegram.js:729-740`) — see Story C5.

#### Story B3 — Auto-expire stuck flight mode
*As Shilo, I don't want flight mode stuck ON if I forget to turn it off (design risk R3).*
- **B3.1** Flight mode **auto-expires 3 hours** after it was last turned on (Q5 — the value is fixed at **3 hours** for MVP).
- **B3.2** After expiry, a voice note follows the normal Hebrew path (as if `/flight_off` had been sent), with no error.
- **B3.3** Expiry is checked at voice-note time (lazy check is acceptable — no timer/cron required); each `/flight_on` resets the 3-hour clock.

### Epic C — Part B: Live voice help

#### Story C1 — Translate airline staff speech
*As Shilo (flight mode ON), I want to record airline staff and get both the exact English and a Hebrew translation.*
- **C1.1** With flight mode ON, a `msg.voice` note routes to `transcribeFlightVoice(fileUrl)` in `skills/flight/index.js`, NOT to `transcribeVoice` (per design §3.1–§3.2).
- **C1.2** `transcribeFlightVoice` returns an object with a verbatim original field and a Hebrew translation field (design §3.2: `{ transcript_verbatim, translation_he, detected_lang }`).
- **C1.3** The reply shows **both**, HE-first format per design §3.2 ("🎙️ מקור (verbatim): …" + "🔁 תרגום: …").
- **C1.4** The reply is sent **directly** via `bot.sendMessage` — it is **NOT** passed to `handleMessage`/the agent (Q2 LOCKED; design §3.1 pseudo-shape returns before the existing path).
- **C1.5** Part B uses a **separate** function and **separate** (multilingual, non-Hebrew-locked) system instruction; `skills/voice/index.js` is not imported, edited, or wrapped (STOP-list).
- **C1.6** Steady-state cost is **exactly 1 Gemini `generateContent` call** per note (≤2 only if R1 fallback is active — Story C6).

#### Story C2 — Verbatim fidelity over formatting
*As Shilo, if the model only returns one block, I'd rather see the raw words than lose content.*
- **C2.1** If the two-field parse fails (only one block returned), the handler shows the raw model output under "מקור" with a note that translation could not be separated, instead of dropping content (design §3.3).

#### Story C3 — Graceful errors
*As Shilo, if transcription fails I want a clear retry hint and flight mode to stay on.*
- **C3.1** Download failure or Gemini error → reply `⚠️ לא הצלחתי לתמלל. נסה שוב או דבר לאט יותר.` (mirrors `bot/telegram.js:739`); flight mode **stays ON**.
- **C3.2** Empty/garbled transcript → return whatever the model gave, plus the hint `(ייתכן שהקול לא היה ברור)` (design §3.3).
- **C3.3** Gemini quota exhausted → same error reply; **Part A still works fully** (0-token), independent of Part B.
- **C3.4** No error path crashes the bot or leaks a stack trace to the chat; errors are `console.error`-logged like the existing voice catch (`bot/telegram.js:737-739`).

#### Story C4 — Airline audio privacy
*As Shilo, the recording of a stranger's voice must not be stored or interpreted by the agent.*
- **C4.1** Airline audio / transcript is **never** written to disk or any data file (no `data/*.json` write in the Part B path).
- **C4.2** Airline audio / transcript is **never** passed to `handleMessage` or any agent tool (enforced by C1.4's direct-send return).
- **C4.3** The audio buffer is used only for the single transcribe call and not retained beyond the request (no module-level caching).

#### Story C5 — OFF-mode is byte-identical
*As Shilo, when flight mode is OFF my normal Hebrew voice notes must behave exactly as before.*
- **C5.1** With flight mode OFF, a voice note executes the **unchanged** path `bot/telegram.js:729-740` (`transcribeVoice` → `handleMessage` → `sendMessage`).
- **C5.2** The Hebrew voice UX diff is limited to an added **guard branch** before line 729 that returns early only when flight mode is ON; no other line in 726-742 changes behaviour for OFF mode (design §3.1 pseudo-shape).
- **C5.3** Verifiable: `git diff` on the voice block shows the OFF path unmodified except for the added flight-mode branch.

#### Story C6 — R1 fallback (2-call) without changing the integration point
*As the implementer, if one call can't reliably do verbatim+translate, I need a drop-in 2-call fallback.*
- **C6.1** If the R1 gate fails (§5), `transcribeFlightVoice` internally splits into **2 Gemini calls** (call 1 = verbatim transcript with multilingual instruction; call 2 = translate that text to Hebrew) — design §6.
- **C6.2** The **function signature and the `bot/telegram.js` integration point do not change** between the 1-call and 2-call implementations (internal swap only).
- **C6.3** Even in fallback, cost is bounded to **≤2** Gemini calls/note and **never** enters the ReAct loop.

### Epic D — Cross-cutting gates

#### Story D1 — Owner-only access
*As Shilo, no one but me should reach this feature.*
- **D1.1** `/flight`, `/flight_on`, `/flight_off`, the inline keyboard, and the Part B flight-mode branch all gate on `String(chatId) === process.env.TELEGRAM_CHAT_ID` (Hard Constraint 5).
- **D1.2** A non-owner chat triggering any of these gets **no flight functionality** (silent ignore, mirroring `/digest_now` owner gate at `bot/telegram.js:619-623`), and a denial log line is emitted.

#### Story D2 — Shabbat blocking inherited
*As Shilo (shomer Shabbat), the feature must stay silent on Shabbat with no exception (Q7).*
- **D2.1** Part B voice notes sit **after** the Shabbat gate (`bot/telegram.js:711-723`), so they inherit Shabbat blocking automatically — no exception is added (design §1.2, §6 R4).
- **D2.2** No Pikud-style bypass is created for flight notes; the only bypass remains `isPikudAlert` (`bot/telegram.js:717`).
- **D2.3** Part A `/flight` commands: their behaviour under the Shabbat gate is whatever the existing gate already does for commands — this PRD introduces **no new** Shabbat exception of any kind (Q7 LOCKED).

#### Story D3 — Lean surface respected
*As the owner, I want this to add minimal new surface.*
- **D3.1** The change set is exactly: `skills/flight/index.js` (new), `skills/flight/content.js` (new), and 2 edit sites in `bot/telegram.js` (command registration + voice-block branch) — per design §1.1. No other production file is modified.
- **D3.2** `skills/flight/index.js` exports `tools: []`; the loader (`bot/skills-registry.js`) registers **zero** agent tools for it (design §1.2).
- **D3.3** Existing Groq 100K/day budget, `bot/rate-limiter.js`, and the 07:00 / 21:00 / Friday / Sunday proactive schedulers are **untouched** and **unaffected** (design §5).

---

## 4. Non-Functional Requirements (NFR)

- **NFR-1 — Token budget.** Part A (menu, all sections, `/flight_on`, `/flight_off`, keyboard) = **0 LLM tokens**. Part B = **≤1 Gemini call/note** (≤2 only under the R1 fallback). No use of Groq, no entry into the ReAct loop, no effect on `bot/rate-limiter.js` (500 calls/day) or the Groq 100K/day budget (design §5).
- **NFR-2 — Disclaimer invariant (test-enforced).** Because **no global runtime interceptor exists** (design §4, confirmed against the conditional append in `skills/research/index.js`), the disclaimer guarantee is enforced by a **unit test** asserting that every section in `MEDICAL_LEGAL_SECTIONS = ['rights','security','wheelchair','docs']` returns `needs_disclaimer === true` with non-empty `disclaimer_he` + `disclaimer_en`, and that the `/flight` handler appends them. This test is part of Definition of Done (§8).
- **NFR-3 — Latency.** Part A replies are effectively instant (string return, no network/LLM). Part B target: a single `gemini-3-flash-preview` `generateContent` call (same model as `skills/voice/index.js:45`); user-perceived latency comparable to the existing Hebrew voice transcription. A 2-call fallback (R1) roughly doubles Part B latency — acceptable, still interactive.
- **NFR-4 — Privacy.** Airline audio and its transcript are **not persisted** (no file/DB write) and **not sent to the agent** (direct send only). Buffer is request-scoped (Story C4).
- **NFR-5 — No regression to existing voice UX.** OFF-mode path through `bot/telegram.js:729-740` is byte-identical; `skills/voice/index.js` is not touched (STOP-list).
- **NFR-6 — Owner-only.** All entry points gate on `String(chatId) === process.env.TELEGRAM_CHAT_ID` (Hard Constraint 5).
- **NFR-7 — Resilience / independence.** A Gemini outage degrades Part B only; Part A remains fully functional (0-token). No flight code runs on any scheduler/cron.
- **NFR-8 — Observability.** Each command handler emits an entry log; each Part B error path uses `console.error` (consistent with existing handlers).

---

## 5. R1 — Mandatory Verification Gate (pre-merge acceptance criterion)

This is a **hard gate**: Part B must not merge until it passes (design §6, R1).

- **G1 — 5-clip test.** Before merging Part B, run **5 English airport/airline-staff-style audio clips** through `transcribeFlightVoice` and **manually verify** for each:
  - (a) **Verbatim transcription accuracy** — the English original is captured faithfully, not summarised/paraphrased.
  - (b) **Hebrew translation accuracy** — the translation is correct and complete.
  - (c) **Two-field parse success** — the verbatim original and the Hebrew translation are cleanly separated into the two output fields.
- **G2 — Pass condition.** All 5 clips satisfy (a), (b), and (c) in the **1-call** implementation → ship 1-call.
- **G3 — Fail → fallback.** If any clip fails (a/b/c) → switch to the **2-call** fallback (call 1 verbatim transcript, call 2 Hebrew translation) with the **same function signature and integration point** (Story C6); re-run G1 on the fallback before merge.
- **G4 — Evidence.** The 5-clip results (pass/fail per clip, and which implementation shipped) are recorded in the PR description before merge.

---

## 6. Preconditions & Blockers

- **R2 — Content dependency (BLOCKER, Q9 OPEN).** The finalised HE+EN content for `skills/flight/content.js` is **NOT YET DELIVERED**. The owner intended to paste it but it arrived as a placeholder. Implementation of Part A is **BLOCKED** until the owner supplies the finalised content:
  - pre-flight **checklist**
  - **required documents**
  - **wheelchair / battery rules**
  - **rights** text (queue exemption for him + 1 companion, manual screening, 48h airline notice)
  - **CRPS security statement**
  - **English phrasebook** (EN phrase + HE gloss)
  - the HE+EN **disclaimer** strings (or confirmation to use the design §2.4 wording)

  **Hard rule: do NOT invent, draft, or auto-generate any of this content.** "Owner supplies finalised `content.js` content" is an explicit precondition that gates the build. The architecture is content-agnostic (design §6 R2), so the skill skeleton (logic, routing, tests) may be scaffolded with placeholder constants, but **no merge of Part A** until the real content is provided and reviewed.
- **Approval gate.** This PRD itself requires human approval (this is the BMAD Phase 3 STOP point).

---

## 7. Budget / Scope Constraints + STOP-list (carried forward)

### 7.1 Hard constraints (locked)
1. **INFO + TRANSLATION only** — no booking/check-in/action automation.
2. **Disclaimer** on every rule/right-asserting section (rights, security, wheelchair, docs), HE+EN, enforced by **unit-test invariant** (no global runtime interceptor — design §4).
3. **Lean build** — reuse existing voice/Gemini/static-constant patterns. New surface = **2 new files** (`skills/flight/index.js`, `skills/flight/content.js`) + **2 edit sites in `bot/telegram.js`** only.
4. **Token budget** — Part A = 0 LLM tokens; Part B ≤1 Gemini call/note (≤2 only on R1 fallback). No impact on Groq 100K/day, `bot/rate-limiter.js`, or proactive schedulers.
5. **Owner-only** — gate on `String(chatId) === process.env.TELEGRAM_CHAT_ID`.

### 7.2 STOP-list — do NOT touch (design §7)
- `skills/research/*`, the generators + the 6 landing templates, the lead pipeline.
- `bot/rate-limiter.js`.
- Health-logging code.
- **`skills/voice/index.js` `transcribeVoice()` and its Hebrew system instruction** (`skills/voice/index.js:46`, `:50`) — Part B MUST be a **separate** `transcribeFlightVoice()` in `skills/flight/`, never an edit to the Hebrew path.
- The existing Hebrew voice UX OFF-path through `bot/telegram.js:729-740` → `handleMessage` must remain **byte-identical**.
- No booking / check-in / action automation of any kind.

---

## 8. Definition of Done

Part A and Part B each have their own DoD; both share the cross-cutting items.

**Shared**
- [ ] Exactly 2 new files + 2 `bot/telegram.js` edit sites; `git diff` shows no other production-file changes (D3.1).
- [ ] `skills/flight/index.js` exports `{ name, description, tools: [], execute, transcribeFlightVoice }`; `tools` is empty (D3.2).
- [ ] All entry points gate on `String(chatId) === process.env.TELEGRAM_CHAT_ID` (D1.1).
- [ ] OFF-mode Hebrew voice path is byte-identical (C5.3 `git diff` evidence).
- [ ] No new Shabbat exception; Part B inherits the existing gate (D2).

**Part A**
- [ ] **R2 content delivered, reviewed, and placed in `skills/flight/content.js`** (no invented content) — precondition cleared.
- [ ] `/flight` menu + all six sections render correct HE+EN, 0 LLM tokens, via both typed args and inline keyboard (A1–A3).
- [ ] Disclaimer co-located in rights/security/wheelchair/docs and appended when `needs_disclaimer === true` (A4).
- [ ] **Unit test for the disclaimer invariant passes** (NFR-2 / A4.5).

**Part B**
- [ ] `transcribeFlightVoice` returns verbatim + Hebrew, sent directly (not via agent), ≤1 Gemini call (C1).
- [ ] Error/fallback behaviours implemented (C2, C3) and privacy guarantees hold (C4).
- [ ] `/flight_on` ÷ `/flight_off` toggle + 3-hour auto-expire work (B1–B3).
- [ ] **R1 5-clip gate passed** (1-call) OR **2-call fallback in place and re-verified**, with results recorded in the PR (§5, G1–G4).

**Sign-off**
- [ ] Human approval of this PRD obtained before implementation begins.
- [ ] PR description documents: change-set surface, R1 results, and that no STOP-list item was touched.

---

## 9. Traceability — design references used

| PRD element | Design source (`docs/flight-companion-design.md`) | Code anchor |
|---|---|---|
| Part A direct-execute pattern | §0, §1.2, §2.2 | `bot/telegram.js:591-614`, `skills/research/index.js` |
| `execute()` JSON-string contract | §2.3 | `bot/telegram.js:596` |
| Disclaimer co-location + test invariant | §2.4, §4 | `skills/research/index.js:92` |
| Voice routing / toggle | §3.1 | `bot/telegram.js:726-742` |
| `transcribeFlightVoice` separate fn | §3.2, §7 | `skills/voice/index.js:38-55` |
| Error/fallback | §3.3 | `bot/telegram.js:737-739` |
| Token/cost analysis | §5 | — |
| R1 verification gate + 2-call fallback | §6 (R1) | — |
| R2 content blocker | §6 (R2) | — |
| Shabbat inheritance | §1.2, §6 (R4) | `bot/telegram.js:711-723` |
| Owner-only gate | (Hard Constraint 5) | `bot/telegram.js:619-623` (`/digest_now` precedent) |
| STOP-list | §7 | — |

---

## 10. Owner-approved decisions (Q1–Q9 — LOCKED)

| # | Decision | Encoded in |
|---|---|---|
| Q1 | Voice routing via per-session `/flight_on` ÷ `/flight_off` toggle; Hebrew voice UX byte-identical when OFF. | Epic B, Story C5, NFR-5 |
| Q2 | Part B = verbatim transcript + Hebrew translation sent **directly** to user, never via agent/ReAct loop. | Story C1.4, C4.2 |
| Q3 | Content stored as **in-code constants** in `skills/flight/content.js`. | §2.1 #2, §2.2 out-of-scope |
| Q4 | "Suggest a reply" **DEFERRED** from MVP (out of scope). | §2.2 |
| Q5 | Flight-mode state **in-memory only**, **auto-expire after 3h**. | Story B1.1, B3.1 |
| Q6 | Part A UX = **both** inline keyboard **and** typed args. | Story A3, A1.3 |
| Q7 | **Keep Shabbat blocking intact** — no exception; Part B inherits the gate. | Story D2 |
| Q8 | Disclaimer attaches to **rights + security + wheelchair + docs**; HE+EN baked into content objects. | Story A4, NFR-2 |
| Q9 | Content = **NOT YET DELIVERED** — pending data dependency that **blocks** implementation; do not invent. | §6 (R2) |

---

*STOP. This PRD is the Phase 3 deliverable. Await human approval AND clearance of the R2 content blocker before any implementation. No code is to be written as part of this phase.*
