# CRPS Research Agent — Product Requirements Document (PRD)

| Field | Value |
|---|---|
| Author | PM — BMAD Product Manager (📋) |
| Date | 2026-05-03 |
| Mode | PRD ONLY — no code, no DDL changes from Winston's design |
| Phase | 3 of 6 (analyst → architect → **PM** → dev → QA → docs) |
| Predecessor | `01b-architect-design-crps.md` (approved by Shilo, all Q15–Q25 decisions accepted) |
| Successor (gated) | Phase 4 — `@dev` implementation |
| Branch | `research/crps-agent-phase1` (this doc is the only diff in this commit) |
| Hard-constraint compliance | Re-verified §11; zero modifications to existing components |

---

## TL;DR — תקציר מנהלים

- **המוצר:** סקיל מחקר CRPS אישי תחת `/research` בבוט הקיים. שילה שואל → הבוט מחזיר 5 מאמרים מסוננים רגשית מ-PubMed/ClinicalTrials.gov/medRxiv → תרגום עברית קצרה + קישור אנגלי. ניסויים ישראליים שמגייסים מודגשים. on-demand בלבד, אפס הודעות פרואקטיביות.
- **סקופ MVP:** 4 כלים (`search_research`, `subscribe_research_topic`, `get_research_history`, `set_research_profile`), 4 טבלאות חדשות (RLS+FORCE), 3 source adapters, Hope Filter דו-שלבי (15-keyword pre-filter + Gemini 2.5 Flash classifier), bilingual UI, daily disclaimer.
- **DoD:** 12 user stories בעברית + ACs קונקרטיים, 5 success metrics ניתנים-למדידה (0 Tier-3 leaks, <10% pre-filter false-positives, <$0.10/חודש, ≥9/10 fixture pass, 0 רגרסיה ב-existing features), Out-of-Scope מפורש (אין multi-user, push notifications, web UI, וכו').
- **5 Implementation sub-phases** (4a→4e) ל-`@dev`: DB → Sources → Filter → Tools → Skill registration. כל phase יוצא עם exit criteria ברורים.
- **Dependencies:** הכל פנימי + חינמי. `NCBI_API_KEY` אופציונלי. אפס תלויות חיצוניות חדשות מעבר ל-Gemini API שכבר בבוט.
- **Open Questions ל-Phase 4:** רק 3 (Q26–Q28) — Mary ו-Winston כיסו את רוב המרחב. כולם low-stakes.

---

## 1. Feature Summary — Executive Description

`/research` הוא Skill חדש בבוט LifePilot שמספק לשילה גישה אישית, עברית-first, מסוננת-רגשית לעדכוני מחקר על CRPS. הסקיל מאחד 3 מקורות מדעיים מובילים (PubMed, ClinicalTrials.gov, medRxiv), מסנן כל מאמר דרך מנגנון Hope Filter דו-שלבי (חוסם prognosis pessimism, פטיינט-אנקדוטות, ושפה חזקה; משאיר טיפולים חדשים, ניסויים מגייסים, ופריצות מנגנון), ומסכם בעברית עם קישור אנגלי. הסקיל הוא 100% additive — אפס שינוי לקוד הקיים, לטבלאות הקיימות, ל-cron jobs, או למשתני env. הוא רץ on-demand בלבד; אין הודעות פרואקטיביות.

**שורת המתח המרכזית של המוצר:** הוא חייב להיות שימושי בלי להיות מסוכן. שילה הוא חולה CRPS מאז 2018 — הצגת תוכן רגשי מאיים תזיק יותר משתעזור. Hope Filter הוא לא תוסף; הוא הליבה.

---

## 2. User Stories

### US01 — Basic research query

> **As a** CRPS patient, **I want** to ask `/research` and receive 5 emotionally-safe research articles, **so that** I stay informed without being overwhelmed.

### US02 — Topic subscription

> **As a** CRPS patient, **I want** to subscribe to specific topics like "ketamine" or "DRG stimulation", **so that** I can track research progress on treatments I'm interested in.

### US03 — Profile management

> **As a** CRPS patient, **I want** to update my treatment profile (current medications, interventions, preferences), **so that** the bot personalizes what's surfaced to my actual context.

### US04 — Review history

> **As a** CRPS patient, **I want** to see what was previously surfaced to me, **so that** I can revisit articles I haven't gotten back to.

### US05 — Force fresh fetch

> **As a** CRPS patient, **I want** to bypass the 6-hour cache with `--refresh`, **so that** I can pull the latest results when something noteworthy may have just been published.

### US06 — Daily disclaimer

> **As a** CRPS patient, **I want** to see a clear disclaimer before consuming research info each day, **so that** I'm reminded the content isn't medical advice.

### US07 — Bilingual presentation

> **As a** CRPS patient who is most comfortable in Hebrew but can read English, **I want** Hebrew summaries with English source links, **so that** I get the gist quickly and can dig into the original when relevant.

### US08 — Treatment safety

> **As a** CRPS patient on an established treatment regimen, **I want** the bot to never recommend stopping or changing my current treatment, **so that** my care continuity isn't undermined.

### US09 — Israeli trials priority

> **As a** CRPS patient living in Israel, **I want** recruiting Israeli clinical trials highlighted prominently, **so that** I can consider participation in studies geographically accessible to me.

### US10 — Profile change confirmation

> **As a** CRPS patient who has lived with the condition for years, **I want** explicit confirmation before my treatment list changes, **so that** typos or misunderstandings don't corrupt my profile.

### US11 — Filter transparency

> **As a** CRPS patient, **I want** to see what kinds of articles were blocked by the filter (without seeing the content itself), **so that** I can verify the filter isn't hiding research I actually want.

### US12 — No regression of existing features

> **As an** existing user of the bot, **I want** all current features (tasks, health logs, habits, expenses, watchlist, doc summaries, image edits, calendar/Gmail integration, etc.) to keep working unchanged, **so that** my daily workflow isn't disrupted.

---

## 3. Acceptance Criteria

ACs קונקרטיים פר user story. Format: AC ID + condition + measurable pass/fail.

### US01 — Basic research query

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC01.1 | `/research` (no args) returns | up to 5 articles, each with `tier ∈ {1, 2}` |
| AC01.2 | All returned articles | have `tier ≠ 3` (auto-filtered) |
| AC01.3 | Each article object | contains `title_he`, `summary_he`, `url`, `source`, `tier`, `published_at` |
| AC01.4 | End-to-end latency | ≤ 15 seconds (95th percentile) on warm cache; ≤ 30s on cold cache |
| AC01.5 | If no articles available | returns Hebrew message "לא נמצא מחקר חדש העונה לקריטריונים" — not an empty array silently |

### US02 — Topic subscription

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC02.1 | `subscribe_research_topic(topic, keywords)` | upserts row in `research_topics` with `(chat_id, topic)` UNIQUE |
| AC02.2 | Active subscriptions | influence article ranking on subsequent `/research` calls |
| AC02.3 | `active=false` | hides topic without deletion (can be re-activated) |
| AC02.4 | Hebrew topic names | accepted as-is (UTF-8) |

### US03 — Profile management

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC03.1 | `set_research_profile(profile_he, treatments, preferences)` | upserts in `research_user_profile` per `chat_id` (PK) |
| AC03.2 | When `treatments` array changes | tool returns `confirmation_needed=true` and waits for next user turn |
| AC03.3 | PHI fields | never appear in logs (Render console, Telegram echo, error messages) |
| AC03.4 | `updated_at` | auto-updates via DB trigger on every UPDATE |

### US04 — Review history

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC04.1 | `get_research_history(limit?)` | returns articles `ORDER BY surfaced_at DESC LIMIT min(limit, 50)`; default 10 |
| AC04.2 | Result | scoped to `surfaced_to_chat_id = $current_chat_id` only |
| AC04.3 | Each entry | shows `tier`, `title_he`, `url`, `surfaced_at` |
| AC04.4 | Empty history case | returns Hebrew message "עוד לא הוצגו מאמרים" |

### US05 — Force fresh fetch

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC05.1 | `search_research(refresh=true)` | skips the 6h cache TTL check |
| AC05.2 | All 3 adapters | are re-queried regardless of `fetched_at` |
| AC05.3 | Existing rows in `research_articles` | dedup via `UNIQUE(source, source_id)` — no duplicates |
| AC05.4 | If a source is rate-limited | adapter returns gracefully; flow continues with the others |

### US06 — Daily disclaimer

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC06.1 | First `/research` of day (Asia/Jerusalem) | response includes `disclaimer_he` field |
| AC06.2 | Disclaimer text | includes phrase "אינו מהווה ייעוץ רפואי" + "התייעצות עם הצוות הרפואי" |
| AC06.3 | After display | `last_disclaimer_seen` set to current timestamp |
| AC06.4 | Same-day subsequent call | does NOT include `disclaimer_he` field |

### US07 — Bilingual presentation

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC07.1 | Each article result | has both `title_he` (Hebrew) and `title_en` (original English) |
| AC07.2 | `summary_he` | is a Hebrew translation/condensation, ≤ 50 words |
| AC07.3 | `url` | is the source link (typically English) |
| AC07.4 | Hebrew terminology | uses `glossary-he.md` mappings consistently (e.g., "spinal cord stimulation" → "גירוי חוט שדרה") |

### US08 — Treatment safety

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC08.1 | Classifier system prompt | explicitly forbids "stop/change treatment" recommendations |
| AC08.2 | Articles challenging current user treatments | classified as Tier 2 with neutral framing — never Tier 1 ("hope-positive") and never Tier 3 ("blocked") |
| AC08.3 | 10 fixture articles | include ≥ 1 treatment-challenge case; none result in "stop" framing |
| AC08.4 | Classifier output JSON schema | does NOT include any "recommend stopping" field; `framing_he` for Tier 2 explicitly tested for neutrality |

### US09 — Israeli trials priority

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC09.1 | ClinicalTrials.gov adapter | supports filter `country=Israel` |
| AC09.2 | Recruiting Israeli trials | get +1 ranking weight (surface earlier in 5-result list) |
| AC09.3 | Reply | marks Israeli recruiting trials with explicit Hebrew flag (e.g., "🇮🇱 מגייס בישראל") |
| AC09.4 | Direct contact info | NOT included — only `ClinicalTrials.gov` URL (per Shilo's Q5 decision) |

### US10 — Profile change confirmation

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC10.1 | `set_research_profile` with NEW `treatments` | returns `confirmation_needed=true` + Hebrew confirmation message echoing proposed values |
| AC10.2 | Save | happens only after user explicitly confirms ("כן" / "אישור" / "yes") in the next turn |
| AC10.3 | User cancels | profile remains unchanged; bot replies in Hebrew "ההגדרה לא נשמרה" |
| AC10.4 | Edit existing treatment (typo fix) | also triggers confirmation; replace-confirmation explicitly distinguishes from add |

### US11 — Filter transparency

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC11.1 | Every blocked article | logged in `research_blocked_log` with `reason_code`, `blocked_by`, optional `classifier_rationale` |
| AC11.2 | Logs retained | 1 year (per Shilo's Q23) — `blocked_at` indexed; pruning script in Phase 5 |
| AC11.3 | `reason_code` | is from a stable, documented set (e.g., `suicide_keyword`, `disability_stat`, `tier3_anecdote`) |
| AC11.4 | `/research` response | includes `blocked_count` integer for transparency to user |

### US12 — No regression of existing features

| AC ID | Condition | Pass criterion |
|---|---|---|
| AC12.1 | After deploy | all 12 existing tables: 0 schema changes (verified via Supabase Advisor diff or manual `\d` per table) |
| AC12.2 | After deploy | all 4 existing skills (`news`, `vision`, `voice`, `web-search`): unchanged file contents (`git diff` shows 0 lines) |
| AC12.3 | After deploy | all ~12 existing cron jobs: still firing on schedule (verified via Render logs over 24h soak) |
| AC12.4 | After deploy | sample of 5 existing slash commands (`/boker`, `/help`, etc.) work as before |
| AC12.5 | After deploy | smoke tests RT01–RT06 (research) AND sample of T01–T14 (existing tables, from `docs/security/01f` §7.3) all return success |
| AC12.6 | `bot/supabase.js` | byte-identical to current `main` (`git diff main bot/supabase.js` empty) |

---

## 4. Definition of Done (DoD) — MVP Checklist

המוצר נחשב **complete** רק אם **כל** הסעיפים הבאים מסומנים. סדר אינו חשוב; כל סעיף בלתי-תלוי ב-bug-tracker tile של @dev.

### 4.1 Database
- [ ] 4 טבלאות חדשות יצרו בהצלחה (`research_articles`, `research_topics`, `research_blocked_log`, `research_user_profile`)
- [ ] לכל טבלה: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`, אפס policies (per `docs/security/01f` Rule 1)
- [ ] אימות RLS: anon לא מסוגל לקרוא או לכתוב — סקריפט curl מ-Winston §4.6 רץ ועובר על כל 4 הטבלאות
- [ ] Indices לפי §4 ב-`01b` יצרו (3+ indices פר articles, 1+ פר topics, 2+ פר blocked_log, 1 פר profile)
- [ ] Trigger `trg_research_user_profile_updated_at` פעיל (`set_updated_at()` helper יצר אם חסר)

### 4.2 Source Adapters
- [ ] `skills/research/sources/pubmed.js` מיישם את ה-contract: `name`, `fetch`, `parseId`, `rateLimit`, `healthCheck`
- [ ] `skills/research/sources/clinicaltrials.js` כנ"ל; תומך ב-filter `country=Israel`
- [ ] `skills/research/sources/medrxiv.js` כנ"ל
- [ ] כל adapter: unit tests עם mock HTTP — ≥ 1 fetch עובר, ≥ 1 healthCheck עובר
- [ ] Rate limit honored (כל adapter שולח לכל היותר את ה-RPS שהוצהר)

### 4.3 Hope Filter
- [ ] `skills/research/filter/keywords.js` מכיל את 15 הביטויים שאושרו ב-Q15
- [ ] `skills/research/filter/classifier.js` קורא ל-Gemini 2.5 Flash עם הפרומפט מ-`01b` §6.3
- [ ] JSON schema validation מאומת — חזרה לא תקינה → fail-safe ל-tier 3
- [ ] 10 fixture articles (per `01b` §9.3): ≥ 9/10 מסווגים נכון
- [ ] Hebrew translation spot-check: 5 דוגמאות נקראות אנושית כתקינות

### 4.4 Tool Implementations
- [ ] `search_research` רשום ב-EXTENDED, מחזיר 5 articles + disclaimer + blocked_count
- [ ] `subscribe_research_topic` upserts ל-`research_topics`
- [ ] `get_research_history` מחזיר היסטוריה לפי `chat_id`
- [ ] `set_research_profile` דורש confirmation עבור treatment changes (per Q20)

### 4.5 Skill Registration
- [ ] `skills/research/SKILL.md` קיים עם תיאור human-readable
- [ ] `skills/research/index.js` מייצא `{ name, description, tools, execute }`
- [ ] `bot/skills-loader.js` סורק ומוצא את הסקיל אוטומטית — log מציג `[Skills] Loaded skill: "research" (4 tool(s))`
- [ ] **0 שינויים ב-`bot/index.js`** (verified via `git diff`)
- [ ] **0 שינויים ב-`bot/agent.js`** (אלא אם Q17 דורש הוספה — STOP escalation)

### 4.6 Telegram UX
- [ ] `/research` slash command או טקסט חופשי "תראה מחקר" מפעילים את הסקיל
- [ ] Reply בעברית קריאה במובייל (≤ 4 פריטים פר הודעה לפי best practice של Telegram)
- [ ] Disclaimer מוצג בקריאה הראשונה של היום (per Q19)
- [ ] Israeli recruiting trials מוצגים עם flag בולט

### 4.7 Documentation
- [ ] `skills/research/SKILL.md` כתוב
- [ ] `skills/research/i18n/glossary-he.js` קיים עם mapping מ-`01a` §6.5
- [ ] `.env.example` עודכן עם `NCBI_API_KEY=optional` (additive only)

### 4.8 Regression Safety
- [ ] All 12 existing tables: schema diff = 0
- [ ] All 4 existing skills: file diff = 0
- [ ] All ~12 cron jobs: still firing (verified 24h post-deploy)
- [ ] Sample of T01–T14 (security smoke tests): PASS
- [ ] Pre-existing 7 dirty/untracked files: STILL unstaged at every commit through Phase 4

### 4.9 Observability
- [ ] Render startup log shows `[Skills] Loaded skill: "research"` line
- [ ] Each `/research` call logs source-by-source latency + token usage
- [ ] Errors don't leak PHI (no `profile_he` content in error stacks)

### 4.10 Cost Verification
- [ ] After 50 simulated `/research` calls, total Gemini token usage measured
- [ ] Projection: < $0.10/month at expected usage (~100 calls/month)

---

## 5. Phasing — MVP vs Phase 5+

### 5.1 MVP (this work — Phase 4 deliverable)

| Component | Scope |
|---|---|
| Sources | 3 — PubMed (E-utilities), ClinicalTrials.gov v2, medRxiv |
| Tools | 4 — search_research, subscribe_research_topic, get_research_history, set_research_profile |
| Tables | 4 — research_articles, research_topics, research_blocked_log, research_user_profile |
| Hope Filter | 15-keyword pre-filter + Gemini Flash classifier with JSON validation |
| UX | Telegram bilingual (he+en), daily disclaimer, Israeli trials flag |
| Profile | Manual subscription (Q6 mode (a)) |
| Cache | 6h TTL + dedup |
| Track-shown | On by default; --refresh to allow |
| Researcher tracking | Active in MVP (per Q25) — articles by tracked researchers auto-Tier-1 |
| Citation logging | On (per Q22) — article click events stored for tier-rule improvement |
| Migrations | Supabase MCP (per Q16) — no `supabase/migrations/` dir |

### 5.2 Phase 5+ (deferred, post-MVP)

| Component | Reason for deferral |
|---|---|
| RSS sources (RSDSA, IASP, Burning Nights, EMA) | RSS endpoints require online verification per source; lower-priority than core academic feeds |
| Cochrane monitoring | No public API; manual or scraping; rare events |
| Israeli MoH announcements | Hebrew HTML scraping; high effort, low CRPS-specific yield |
| Browserless integration | JS-heavy sites (some hospital sites, possibly RSDSA); Browserless = $10–25/month — defer until justified |
| Auto-suggest topics (Q6 hybrid mode) | Requires 2 weeks of usage data to derive; pure post-MVP |
| Weekly digest (NOT proactive — opt-in `/research --weekly`) | Only after MVP usage shows value of bulk format |
| Pruning script for `research_blocked_log` (1y retention) | Needed once log accumulates; trivial cron addition (will be opt-in) |
| Modern Supabase keys (`sb_secret_...`) | Aligned with `docs/security/01f` follow-ups; cross-cutting work |
| `supabase/migrations/` directory introduction | Methodology shift; better as standalone effort |
| Multi-language support beyond he/en | No demand |
| Voice readout of articles | Post-MVP UX exploration |

---

## 6. Success Metrics

| # | Metric | Target | Measurement |
|---|---|---|---|
| M1 | Articles surfaced matching Tier-3 criteria | **0** | Manual sample review of 20 random results monthly; Mary's audit checklist from `01a` §4.3 |
| M2 | Pre-filter false-positive rate | **< 10%** | Review `research_blocked_log` monthly; mark articles where the keyword block was overzealous; rate = false_positives / total_blocked |
| M3 | Total Gemini API cost | **< $0.10/month** | Render logs token counters; aggregate at month end |
| M4 | Existing bot regression | **0 broken features** | Smoke tests RT01–RT06 + sample T01–T14 PASS post-deploy + 24h soak |
| M5 | Hope Filter classifier accuracy | **≥ 9/10 on fixture set** | 10 fixture articles per `01b` §9.3 — re-run after any prompt change |
| M6 | RLS audit | **100% pass** | All 4 new tables: `anon` cannot SELECT, INSERT, or DELETE (per Winston §4.6) |
| M7 | Hebrew translation quality | **Acceptable on 10/10 spot-checks** | Manual review by Shilo on first 10 surfaced articles; threshold = "would I show this to a friend?" |
| M8 | Latency (warm cache) | **≤ 15s p95** | Per-call timing logged; aggregated weekly |

**Re-evaluation cadence:** monthly review of M1, M2, M3, M5, M7. M4, M6, M8 verified at deploy + ad-hoc.

---

## 7. Out of Scope (explicit list — prevents scope creep)

| Item | Reason |
|---|---|
| Multi-user support / accounts / auth | Single-user bot per architecture; PHI confined to single chat_id |
| Push notifications / proactive alerts | Original brief explicitly forbade — preserves on-demand-only |
| Email digests | No email infrastructure in bot; no demand |
| Web UI / dashboard | Bot is Telegram-first; web UI is a separate product |
| iOS / Android native apps | Same as above |
| Patient anecdote aggregation (Reddit, forums, Facebook) | Hard constraint in original brief — Tier-3 always |
| Treatment recommendations | Liability + patient-safety hard line |
| Stopping/changing treatment guidance | Hard constraint US08 |
| Full-text PDF translation | Out-of-scope tooling; abstracts sufficient for MVP |
| Voice readout of articles | Post-MVP UX |
| Article click-through analytics dashboards | MVP logs clicks (per Q22) but no UI to view aggregations |
| Multi-language UI beyond he/en | No demand |
| Integration with EHR / personal health records | Privacy + scope |
| Cochrane full-text fetching | No public API; abstract-only acceptable |
| Real-time alerts on tracked-researcher publications | Post-MVP — would require cron (forbidden) or polling |
| Machine learning re-ranker on top of tier system | Premature; need usage data first |
| Custom keyword-block UI | Phase 5; for now, blocklist edits go through @dev |

---

## 8. Implementation Phases for `@dev` (Phase 4 Sub-Phases)

קצב ההתקדמות: כל sub-phase יוצא עם exit criteria מאומתים לפני המעבר הבא. אין דחיפת כל ה-Phase 4 בקומיט אחד. כל sub-phase = commit נפרד עם תיעוד ב-Render לוג.

### 4a — DB Migrations (4 tables)

**Inputs:**
- DDL מ-`01b` §4
- Supabase MCP access
- Q16 confirmed (Supabase MCP, no `supabase/migrations/` dir)

**Outputs:**
- 4 טבלאות חדשות ב-`public` schema
- כל טבלה: RLS+FORCE+0 policies
- אימות curl מ-`01b` §4.6 עובר

**Exit criteria:**
- ✅ Supabase Advisor: 0 חדשים `rls_disabled_in_public`
- ✅ סקריפט curl: כל 4 הטבלאות → "BLOCKED" ל-anon
- ✅ Service-role read sample: לפחות אחד מהטבלאות מחזיר נתונים (verify access works)

**Estimated effort:** 30 דקות

### 4b — Source Adapters (3 sources)

**Inputs:**
- Adapter contract מ-`01b` §7
- PubMed MeSH search query מ-`01a` §2.1
- ClinicalTrials.gov v2 API spec (Winston יאמת ב-Phase 4)

**Outputs:**
- `skills/research/sources/pubmed.js`
- `skills/research/sources/clinicaltrials.js`
- `skills/research/sources/medrxiv.js`
- `skills/research/sources/_adapter.js` (interface checker)

**Exit criteria:**
- ✅ unit test לכל adapter עובר עם mock HTTP
- ✅ healthCheck() לכל adapter מחזיר true על endpoint אמיתי
- ✅ fetch("CRPS", since=now-30days) מחזיר ≥ 1 article ב-PubMed (CT.gov ו-medRxiv: ≥ 0 — דליל זה תקין)

**Estimated effort:** 4–6 שעות

### 4c — Hope Filter (pre-filter + classifier)

**Inputs:**
- 15 keywords מאושרים (Q15)
- Classifier prompt מ-`01b` §6.3
- glossary-he.md mapping

**Outputs:**
- `skills/research/filter/keywords.js`
- `skills/research/filter/classifier.js`
- `skills/research/filter/tiers.js`
- `skills/research/i18n/glossary-he.js`

**Exit criteria:**
- ✅ Pre-filter: 15 fixture articles עם ביטוי חסום → כולם `blocked_by='pre_filter'` ב-log
- ✅ Classifier: 10 fixture articles מ-`01b` §9.3 → ≥ 9/10 match
- ✅ JSON schema fail-safe: classifier output לא תקין → coerce ל-tier 3 (test case מאומת)
- ✅ Token budget per article: ≤ 1000 tokens (target 730)

**Estimated effort:** 4–6 שעות

### 4d — Tool Implementations (4 tools)

**Inputs:**
- Tool definitions מ-`01b` §5
- DB schema מ-4a
- Filter pipeline מ-4c
- Sources מ-4b

**Outputs:**
- `skills/research/index.js` — orchestrator עם `execute(toolName, args, ctx)` switch
- `skills/research/storage/articles.js`
- `skills/research/storage/topics.js`
- `skills/research/storage/profile.js`
- `skills/research/storage/blocked-log.js`
- `skills/research/utils/disclaimer.js`

**Exit criteria:**
- ✅ search_research מחזיר 5 articles עם disclaimer (פעם ראשונה ביום) + blocked_count
- ✅ subscribe_research_topic upserts בהצלחה; UNIQUE constraint enforced
- ✅ get_research_history scoped ל-chat_id ומחזיר את ה-limit הנכון
- ✅ set_research_profile דורש confirmation עבור treatment changes — מאומת ב-2 turns
- ✅ Israeli recruiting trials מקבלים +1 ranking (ניתן למדוד דרך unit test על ranking function)

**Estimated effort:** 6–8 שעות

### 4e — Skill Registration + Telegram Routing

**Inputs:**
- כל ה-Phase 4a–4d
- Existing skills loader (`bot/skills-loader.js`) — לא נוגע
- Existing telegram routing (`bot/telegram.js`) — verify routing for `/research` works without changes

**Outputs:**
- `skills/research/SKILL.md`
- אישור פינאלי ש-loader טוען את הסקיל
- אישור ש-`/research` מגיע ל-agent ומופעל ב-EXTENDED tier

**Exit criteria:**
- ✅ Render startup log: `[Skills] Loaded skill: "research" (4 tool(s))`
- ✅ Telegram message "/research" מקבל reply תוך 30 שניות
- ✅ Telegram message טקסט חופשי "תראה לי מחקר על ketamine" → agent מסיק intent → קורא ל-search_research
- ✅ `git diff main -- bot/index.js bot/agent.js bot/telegram.js bot/supabase.js bot/skills-loader.js` ריק (0 שינויים)
- ✅ STOP-list re-checked: שום אחד מ-7 הסעיפים ב-`01a` §8.9 לא הופעל

**Estimated effort:** 1–2 שעות

### 4f — Smoke Testing + RLS Audit (gate to Phase 5)

**Inputs:**
- כל ה-Phase 4
- Smoke test plan מ-`01b` §9
- RT01–RT06 + sample T01–T14

**Outputs:**
- Test report ב-`docs/research/01d-dev-implementation.md` (או דומה ל-pattern של security)
- `01e-qa-test-results.md` (אופציונלי — אם @qa מופעל בנפרד)

**Exit criteria:**
- ✅ כל RT01–RT06 PASS
- ✅ sample של 5 מ-T01–T14 PASS (לא רגרסיה ב-existing features)
- ✅ Render logs נקיים מ-401/403/JWT errors מ-Supabase
- ✅ Cost projection אומת על נתוני 50 קריאות

**Estimated effort:** 2–3 שעות

### Total Phase 4 estimated effort

**18–27 שעות** של עבודת @dev. ניתן לפצל לימים מרובים.

---

## 9. Dependencies — Required Before Phase 4 Starts

### 9.1 External

| Dep | Status | Owner | Notes |
|---|---|---|---|
| Gemini API key | ✅ Already configured (`GEMINI_API_KEY` ב-Render) | Shilo | אין צורך בשינוי |
| `NCBI_API_KEY` (PubMed) | 🟡 Optional — ניתן לדחות | Shilo | בלי המפתח, rate = 3 req/sec; מספיק ל-MVP. אם נרצה — registration ב-NCBI חינם |
| Supabase MCP access | ✅ Already used in security work | Claude/Shilo | ל-Phase 4a |
| Render deployment access | ✅ קיים | Shilo | ל-Phase 4e merge + redeploy |

### 9.2 Internal (codebase)

| Dep | Verification needed | Phase to verify |
|---|---|---|
| `bot/skills-loader.js` auto-scans | ✅ Verified by PM (קראתי את הקובץ; auto-scan לפי `bot/skills-loader.js:22–72`) | Phase 3 (this doc) |
| `bot/agent.js` CORE/EXTENDED mechanism | 🟡 Q17 — verify at `bot/agent.js:386` whether new tools auto-go to EXTENDED or require explicit marking | Phase 4 (4e) |
| `bot/supabase.js` service_role client | ✅ Verified by `docs/security/01f` | Already verified |
| `bot/backup.js` table coverage | 🟡 Q18 — verify generic vs list-based | Phase 4 (4a) |
| Pre-existing 7 dirty/untracked files | ✅ Confirmed unstaged at branch creation; will re-verify before each commit in Phase 4 | Each Phase 4 sub-phase |

### 9.3 Decision dependencies (already received)

All Q1–Q25 decisions confirmed from Phases 1+2. **No further decisions needed before Phase 4 begins.**

---

## 10. Open Questions for Shilo (Phase 4 Gating)

PM mostly works from the prior phases. Three small questions remain:

### Q26 — Slash command name
- **(a)** `/research` only (English)
- **(b)** `/research` + Hebrew alias (e.g., `/מחקר`)
- **(c)** `/research` + free-text intent ("תראה לי מחקר", etc.) via agent
- **PM recommendation:** **(c)** — `/research` כ-canonical command, אבל ה-agent יבין גם טקסט חופשי בעברית. תואם לדפוס הקיים בבוט.

### Q27 — User profile bootstrap behavior
- **(a)** Auto-create empty profile on first `/research` (lazy init)
- **(b)** Require explicit `set_research_profile` before first call → otherwise return prompt
- **PM recommendation:** **(a)** — friction-less first use. שילה יקבל disclaimer + מאמרים גנריים בקריאה הראשונה; ה-bot ידחוף עדינות ל-`set_research_profile` בקריאה השנייה.

### Q28 — Tool name finalization
- שמות כפי שהם ב-`01b` §5: `search_research`, `subscribe_research_topic`, `get_research_history`, `set_research_profile`
- אופציה: שמות קצרים יותר (`research`, `research_topic`, `research_history`, `research_profile`) — חוסך ~5 טוקנים פר tool description ב-EXTENDED
- **PM recommendation:** השמות הארוכים (`search_research`, וכו') — ברורים יותר ל-agent בעת disambiguation; חיסכון 5×4 = 20 טוקנים לא משמעותי

---

## 11. Additive-Only Re-Verification (PM-level)

ה-PRD לא מוסיף דרישות מעבר ל-Winston's design. אני מאשר מחדש:

- **0** שינויים ב-`bot/index.js` (verified §4.5 + §4e exit criteria)
- **0** שינויים ב-`bot/supabase.js` (verified §3.1)
- **0** שינויים ב-`bot/agent.js` (CORE/EXTENDED — תלוי Q17 verification ב-Phase 4)
- **0** שינויים ב-`bot/skills-loader.js`
- **0** שינויים ב-`bot/telegram.js`
- **0** טבלאות קיימות נגעות ב-schema
- **0** cron jobs חדשים (US01–US12 כולן on-demand)
- **0** משתני env שונו (NCBI_API_KEY חדש, optional, additive בלבד)
- **0** תיקיות top-level חדשות (הכל ב-`skills/research/` תחת קיים)
- **7** קבצים מלוכלכים קיימים: ייוודאו unstaged בכל commit של Phase 4

**STOP-list (per `01a` §8.9 + `01b` §12.9):**

| # | Trigger | PM verdict |
|---|---|---|
| 1 | שינוי schema של טבלה קיימת | ❌ לא נדרש |
| 2 | שינוי mechanism של loader/routing קיים | ❌ לא נדרש (auto-scan קיים מספיק) |
| 3 | שדרוג `@supabase/supabase-js` | ❌ לא נדרש |
| 4 | שינוי ב-system prompt הראשי של הבוט | ❌ לא נדרש |
| 5 | הוספת cron job | ❌ לא נדרש |
| 6 | שינוי `bot/supabase.js` | ❌ לא נדרש |
| 7 | שינוי `bot/agent.js` בקטע ה-CORE/EXTENDED | ⚠️ pending Q17 verify ב-4e |

אם אחד מ-#1–#6 הופעל ב-Phase 4 → STOP, escalation לשילו. #7 הוא בדיקת אימות, לא שינוי בכוונה.

---

## Handoff Note ל-Phase 4 (`@dev`)

המסמך הזה **אינו משנה דבר בקוד**. הוא מסמך דרישות מוצר.

**מוכן ל-Phase 4 כאשר:**
- שילה מאשר את ה-PRD (כעת)
- שילה עונה על Q26–Q28 (או מאשר את המלצות ה-PM כברירת מחדל)
- @dev מאשר שהוא קורא את `01a`, `01b`, ו-01c (this) במלואם לפני קוד

**מה @dev מקבל:**
- Mary's source landscape + verified API endpoints (online verification ב-Phase 4 לפני בנייה)
- Winston's full DDL + tool schemas + filter spec
- PM's user stories + ACs (criterion למה זה "עובד")
- 5 sub-phases מסודרים עם exit criteria

**מה @dev מסכים לוותר עליו:**
- Phase 5+ items (RSS, Cochrane, MoH IL scraping, etc.)
- Out-of-scope items (§7)

**Hard constraints — restated:**
- Feature 100% additive — re-verified §11
- Pre-existing 7 dirty/untracked files MUST stay unstaged through every Phase 4 commit
- Emotional safety constraints carry forward into pre-filter + classifier prompt
- Israeli recruiting trials get explicit visual flag in Telegram replies
- Daily disclaimer required on first `/research` per IL day

**מה לעשות אם @dev מתקל בבעיה:**
- אם sub-phase exit criteria לא נפגש → לא לעבור הלאה. לעלות בעיה לשילו.
- אם STOP-list trigger מתאקטב (#1–#6) → STOP. אסקלציה לשילו לפני המשך עבודה.
- אם prerequisite ב-§9.2 נכשל באימות → STOP, להסביר את הבעיה לשילו לפני adapter.

— PM 📋
