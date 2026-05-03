# CRPS Research Agent — Architect Design

| Field | Value |
|---|---|
| Author | Winston — BMAD System Architect (🏗️) |
| Date | 2026-05-03 |
| Mode | DESIGN ONLY — no source files written |
| Phase | 2 of 6 (analyst → **architect** → PM → dev → QA → docs) |
| Predecessor | `01a-analyst-findings-crps.md` (approved by Shilo, all 14 Q decisions accepted) |
| Successor (gated) | Phase 3 — PM/PRD |
| Branch | `research/crps-agent-phase1` (this doc is the only diff in this commit) |
| Risk class | **Low-Medium** — additive-only feature, but emotional-safety classifier is novel surface |
| Hard-constraint compliance | Re-verified §12; zero modifications to existing components |

---

## TL;DR — תקציר מנהלים

- **המלצה אדריכלית: Option D** — skill עצמאי תחת `skills/research/` עם sub-modules פנימיים (`sources/`, `filter/`, `storage/`). דוחה את A (monolith — לא ניתן לתחזוקה), B (`bot/research/` — מפזר באופן מיותר על שתי תיקיות top-level), ו-C (Edge Functions — over-engineering לפיצ'ר on-demand יחיד-משתמש).
- **DB: 4 טבלאות חדשות, אפס שינוי בקיים.** כל DDL כולל `ENABLE` + `FORCE` RLS באותה מיגרציה (חובה מ-`docs/security/01f` Rule 1). Foreign keys ל-`chat_id` (אינדקס משני). אפס policies — רק service_role ניגש דרך הבוט.
- **Hope Filter דו-שלבי.** שלב 1: keyword pre-filter דטרמיניסטי (15 ביטויים מוצעים — דורש אישור שילה). שלב 2: Gemini 2.5 Flash classifier עם prompt ייעודי (עברית + English) שמחזיר JSON מאומת (`tier`, `framing_he`, `block_reason`, `rationale`). תקציב טוקנים: ~600 לכל מאמר → ~$0.007/חודש בתחזית 100 מאמרים.
- **Source adapter contract אחיד**: 3 adapters (pubmed, clinicaltrials, medrxiv) ב-MVP. כולם מיישמים `fetch(query, since)`, `parseId`, `rateLimit`. מקורות RSS/scraping נדחים ל-Phase 5+.
- **רולבק נקי**: rename של `skills/research/` ל-`skills/_disabled_research/` → ה-loader מתעלם, פיצ'ר מושבת ב-30 שניות, אפס איבוד נתונים. drop של טבלאות ייעשה רק אם מתבקש ידנית (ברירת מחדל: שמירה).
- **§12 — אישור סופי שהפיצ'ר אדיטיבי 100%.** 0 שינויי `bot/index.js`, 0 cron חדש, 0 שינוי בטבלאות הקיימות, 0 שינוי `bot/supabase.js`, 0 שינוי בכלי CORE.

---

## 1. Brainstorm — Architectural Alternatives

ארבע אופציות (Shilo הציע 3 בברית; אני מוסיף Option D כסינתזה).

### Option A — Monolithic `skills/research/index.js`

כל הלוגיקה (sources, filter, storage, tools) בקובץ יחיד.

| Aspect | Detail |
|---|---|
| LOC estimate | 1200–1800 |
| Files added | 2 (`SKILL.md`, `index.js`) |
| Token economy (CORE) | 0 — כל ה-tools ב-EXTENDED |
| Testability | **רע מאוד** — כל test דורש מָק של LLM, HTTP, ו-DB ביחד |
| Code review surface | קובץ ענק → review מתערפל; קל לפספס regression |
| Future extensibility | קשה — הוספת מקור חדש = פתיחת monolith ועריכה במקום מסוכן |
| Deployment complexity | זהה ל-D (skills loader זהה) |

**נדחה** — קוד שלא ניתן לבחון בקטעים זה חוב טכני נולד.

### Option B — Skill thin-shim + `bot/research/` heavy modules

`skills/research/index.js` הוא shim של ~50 שורות שמייצא tools ומאציל ל-`bot/research/{sources,filter,storage}/`.

| Aspect | Detail |
|---|---|
| LOC estimate | 1500 כולל (skill 50 + bot/research/ 1450) |
| Files added | ~15 (2 ב-skill + 13 תחת bot/research/) |
| Token economy | 0 |
| Testability | **טוב** — modules נטו testable |
| Code review surface | טוב — קבצים קטנים |
| Future extensibility | **טוב** — מקור חדש = קובץ חדש תחת `bot/research/sources/` |
| Deployment complexity | זהה |
| **Concern** | מפצל פיצ'ר *אחד* על שתי top-level directories. הקוד של "research" חי גם ב-`skills/research/` וגם ב-`bot/research/` — נורמלי לזהות שצריך לקרוא שני מקומות, סיכון לפגישה לא-מתואמת בעדכון |

**נדחה** — הפיזור על שתי תיקיות הוא חיסרון בלי תועלת ל-skill עצמאי. `bot/` הוא לקוד-ליבה משותף לכל הבוט; קוד ייעודי ל-skill צריך לחיות עם ה-skill.

### Option C — Skill + Supabase Edge Functions

מקורות נשלפים ב-Edge Functions (Supabase serverless). ה-skill קורא ל-Edge endpoints, מקבל articles נורמליזציה, מבצע filter+storage.

| Aspect | Detail |
|---|---|
| LOC estimate | 800 (skill) + 600 (Edge TS) = 1400 |
| New deployment surfaces | Supabase Edge runtime, secrets management חיצוני |
| Latency | בעלייה של 100–300ms (קפיצה נוספת) |
| Cost | Edge Functions free tier מספיק; אבל **הוספת תשתית = הוספת fail-mode** |
| Testability | טוב, אבל מפוזר על שתי שפות (TypeScript ב-Edge, JS בבוט) |
| Future extensibility | מצוין — Edge יכול לרוץ scheduled fetches בעתיד |
| Deployment complexity | **גבוה** — `supabase functions deploy`, סודות ב-Edge, monitoring חדש |
| **Hard-constraint risk** | אם Edge Function דורש env var חדש בקוד הבוט (`SUPABASE_FUNCTIONS_URL` למשל) — זה תוספת אדיטיבית, אבל רף הסיבוך עולה משמעותית |

**נדחה** — over-engineering לפיצ'ר ש-(a) on-demand בלבד, (b) משתמש יחיד, (c) MVP. ערך עתידי קיים אבל לא מצדיק את העלייה ברף הסיבוך עכשיו. *ניתן לעבור ל-Edge ב-Phase 5 אם תרגיש שהפיצ'ר נכנס לשימוש כבד.*

### Option D — Skill self-contained with internal sub-modules ⭐ (recommended)

כל הקוד תחת `skills/research/`, בארגון פנימי לתת-תיקיות.

```
skills/research/
├── SKILL.md                 # תיאור human-readable
├── index.js                 # exports { name, description, tools, execute } — thin orchestrator (~150 שורות)
├── sources/
│   ├── pubmed.js
│   ├── clinicaltrials.js
│   ├── medrxiv.js
│   └── _adapter.js          # contract definitions (interface check)
├── filter/
│   ├── classifier.js        # Gemini call
│   ├── keywords.js          # pre-filter blocklist
│   └── tiers.js             # tier rules + framing
├── storage/
│   ├── articles.js          # research_articles CRUD
│   ├── topics.js            # research_topics CRUD
│   ├── profile.js           # research_user_profile CRUD
│   └── blocked-log.js       # research_blocked_log CRUD
├── i18n/
│   └── glossary-he.js       # Hebrew medical terminology mapping (per Mary §6.5)
└── utils/
    └── disclaimer.js        # legal text + first-time presentation gate
```

| Aspect | Detail |
|---|---|
| LOC estimate | 1200–1500 |
| Files added | ~13–15 (כולם תחת `skills/research/`) |
| Token economy (CORE) | 0 — כל הכלים ב-EXTENDED |
| Testability | **טוב מאוד** — module-level tests, mock-friendly |
| Code review surface | מצוין — review per file (~80–150 שורות לקובץ) |
| Future extensibility | מצוין — מקור חדש = קובץ ב-`sources/` |
| Deployment complexity | **מינימלי** — `skills-loader.js` סורק אוטומטית, אין שינוי קוד הבוט |
| Pre-existing patterns | תואם ל-skills קיימים (`news/`, `vision/`, `voice/`, `web-search/`) |

**מומלץ.** מקיים את כל יעדי Phase 1, ללא חסרונות של A/B/C.

---

## 2. Decision

**Option D — Skill self-contained with internal sub-modules.**

נימוקים:
1. **Self-containment** — כל הקוד של הפיצ'ר חי במקום אחד. רולבק = rename של תיקייה אחת. review = path אחד.
2. **Tracks existing skill convention** — `news/`, `vision/`, `voice/`, `web-search/` כולם self-contained. עקביות ארכיטקטונית.
3. **Testability without abstraction tax** — sub-modules ניתנים לבדיקה בנפרד, אבל מבלי להעמיס מבנה תיקיות שטוח-ומסובך כמו ב-B.
4. **Zero changes to bot/** — `skills-loader.js` קיים יודע לטפל בקבצים אדיטיביים בלבד. אין צורך לגעת בליבה.
5. **Reversibility** — disable trivial: `mv skills/research skills/_disabled_research`. הסקילי הופך לבלתי-נראה ל-loader.

**נדחה:** A (monolith), B (`bot/research/` split), C (Edge Functions). מפורטים בסעיף 1.

---

## 3. Component Diagram — Data Flow

```
┌──────────────┐
│   Telegram    │  שילו: "/research" or "תראה לי מחקר על ketamine"
└──────┬───────┘
       │ webhook POST
       ▼
┌──────────────────────┐
│ bot/telegram.js       │  ← /slash routing OR free-text → agent
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ bot/agent.js (ReAct) │  ← detects "research" intent → invokes EXTENDED tool
└──────┬───────────────┘
       │ tool call: search_research(...)
       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ skills/research/index.js — orchestrator (~150 LOC)                           │
│                                                                             │
│   1. resolve query/topic/profile → effective queries                        │
│   2. for each adapter in [pubmed, clinicaltrials, medrxiv]:                 │
│        ├─ check storage/articles cache (TTL 6h, per Q2)                     │
│        └─ if miss/stale → adapter.fetch(query, since)                       │
│   3. dedup by source_id (already-surfaced filter)                           │
│   4. for each candidate article:                                             │
│        ├─ filter/keywords.js (pre-filter — fast, no LLM)                    │
│        │     ├─ if blocked → log to research_blocked_log → drop             │
│        │     └─ else → continue                                              │
│        └─ filter/classifier.js (Gemini Flash)                                │
│              ├─ tier 1 → surface immediately                                 │
│              ├─ tier 2 → surface with framing_he                             │
│              └─ tier 3 → log to research_blocked_log → drop                  │
│   5. storage/articles.js — upsert surfaced articles, set surfaced_at        │
│   6. format reply (Hebrew summary + English link, per Q3)                   │
│   7. attach disclaimer if first-of-day (utils/disclaimer.js)                 │
└─────────────────────────────────────────────────────────────────────────────┘
       │ return tool result
       ▼
┌──────────────────────┐
│ bot/agent.js          │  → renders reply text
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ bot/telegram.js       │  → sendMessage to Shilo
└──────────────────────┘
```

**צרכני DB (read+write):** רק `skills/research/storage/*.js`. אפס מגע עם הטבלאות הקיימות.

**צרכני LLM:** רק `skills/research/filter/classifier.js` (Gemini Flash). הבוט הראשי ממשיך עם Groq/Gemini הקיימים — אין שינוי בנתיב ה-LLM הקיים.

**צרכני HTTP חיצוני:** רק `skills/research/sources/*.js`. אין הוספת dependencies חיצוניים מעבר ל-`fetch` המובנה ב-Node 18+.

---

## 4. Database Schema — DDL

כל DDL כתוב כאן הוא **מוצע**. ה-execution יעבור ב-Supabase MCP בעת Phase 4 (per §11), לא בקובץ זה.

### 4.1 `research_articles`

```sql
-- Surfaced articles cache + dedup ledger.
-- Public-content metadata (title/abstract/url) + per-user surfacing state.

CREATE TABLE public.research_articles (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text          NOT NULL,                -- 'pubmed' | 'clinicaltrials' | 'medrxiv'
  source_id       text          NOT NULL,                -- PMID, NCT id, doi — adapter-specific
  title           text          NOT NULL,
  abstract        text,
  url             text          NOT NULL,
  authors         text[]        NOT NULL DEFAULT '{}',
  published_at    timestamptz,
  fetched_at      timestamptz   NOT NULL DEFAULT now(),
  tier            int           NOT NULL,                -- 1 | 2 | 3 (3 should never appear here — they go to blocked_log)
  framing_he      text,                                  -- present iff tier=2
  classifier_rationale text,                             -- LLM internal rationale (English, debug only)
  -- Per-user surfacing state:
  surfaced_to_chat_id bigint,                            -- nullable until first surface
  surfaced_at         timestamptz,                       -- nullable until first surface
  CONSTRAINT chk_tier CHECK (tier IN (1, 2)),
  CONSTRAINT chk_source CHECK (source IN ('pubmed', 'clinicaltrials', 'medrxiv')),
  CONSTRAINT uniq_source_article UNIQUE (source, source_id)
);

COMMENT ON TABLE  public.research_articles IS 'CRPS research aggregator: surfaced articles cache with hope-filter tier and per-user surfacing state.';
COMMENT ON COLUMN public.research_articles.source_id IS 'Adapter-specific stable id: PMID for pubmed, NCT id for clinicaltrials, doi for medrxiv.';
COMMENT ON COLUMN public.research_articles.tier IS 'Hope-filter classification: 1=surface, 2=surface-with-framing. Tier 3 articles never reach this table.';

-- Indices for common queries:
CREATE INDEX idx_research_articles_chat_recent
  ON public.research_articles (surfaced_to_chat_id, surfaced_at DESC)
  WHERE surfaced_to_chat_id IS NOT NULL;
CREATE INDEX idx_research_articles_source
  ON public.research_articles (source, fetched_at DESC);
CREATE INDEX idx_research_articles_tier
  ON public.research_articles (tier);

-- RLS — mandatory per docs/security/01f Rule 1:
ALTER TABLE public.research_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_articles FORCE  ROW LEVEL SECURITY;
-- No policies. Deny-by-default for everyone except service_role.
```

### 4.2 `research_topics`

```sql
-- User subscriptions to specific CRPS topics (e.g., "ketamine", "DRG", "neridronate").

CREATE TABLE public.research_topics (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     bigint      NOT NULL,
  topic       text        NOT NULL,                       -- short label, used for /research --topic
  keywords    text[]      NOT NULL DEFAULT '{}',          -- expansion terms for the search
  created_at  timestamptz NOT NULL DEFAULT now(),
  active      boolean     NOT NULL DEFAULT true,
  CONSTRAINT uniq_chat_topic UNIQUE (chat_id, topic)
);

COMMENT ON TABLE public.research_topics IS 'User subscriptions to CRPS research topics. Surfacing prioritizes articles matching active topic keywords.';

CREATE INDEX idx_research_topics_chat_active
  ON public.research_topics (chat_id, active)
  WHERE active = true;

ALTER TABLE public.research_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_topics FORCE  ROW LEVEL SECURITY;
```

### 4.3 `research_blocked_log`

```sql
-- Transparency log of articles blocked by hope filter (pre-filter or LLM tier 3).
-- Auditable record so user can review what's being suppressed and tune the rubric.

CREATE TABLE public.research_blocked_log (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text        NOT NULL,
  source_id          text        NOT NULL,
  title              text        NOT NULL,
  url                text,
  blocked_at         timestamptz NOT NULL DEFAULT now(),
  blocked_by         text        NOT NULL,                 -- 'pre_filter' | 'llm_classifier'
  reason_code        text        NOT NULL,                 -- e.g., 'suicide_keyword', 'tier3_disability_stat', 'tier3_anecdote'
  classifier_rationale text,                               -- present iff blocked_by='llm_classifier'
  CONSTRAINT chk_blocked_by CHECK (blocked_by IN ('pre_filter', 'llm_classifier'))
);

COMMENT ON TABLE public.research_blocked_log IS 'Transparency ledger for hope-filter blocks. User can review periodically to detect filter overshoot or undershoot.';
COMMENT ON COLUMN public.research_blocked_log.reason_code IS 'Short stable identifier for the block category. Allows aggregation queries (e.g., how many articles blocked by suicide_keyword last month).';

CREATE INDEX idx_research_blocked_log_recent
  ON public.research_blocked_log (blocked_at DESC);
CREATE INDEX idx_research_blocked_log_reason
  ON public.research_blocked_log (reason_code);

ALTER TABLE public.research_blocked_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_blocked_log FORCE  ROW LEVEL SECURITY;
```

### 4.4 `research_user_profile`

```sql
-- Per-user CRPS context: current treatments, preferences, disclaimer state.
-- Sensitive PHI — stored under service_role-only RLS lockdown.

CREATE TABLE public.research_user_profile (
  chat_id              bigint      PRIMARY KEY,
  profile_he           text,                              -- free-text Hebrew profile (treatments, preferences, history)
  treatments           text[]      NOT NULL DEFAULT '{}', -- structured list (e.g., ['DRG', 'gabapentin'])
  preferences          jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- e.g., { "language": "he", "articles_per_call": 5 }
  last_disclaimer_seen timestamptz,                       -- gates daily disclaimer (per §6.3 of 01a)
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.research_user_profile IS 'CRPS-specific user context for personalized research surfacing. Sensitive PHI — service_role only.';
COMMENT ON COLUMN public.research_user_profile.profile_he IS 'Free-text Hebrew profile. Never logged or printed; surfaced only via dedicated tools.';

CREATE INDEX idx_research_user_profile_updated
  ON public.research_user_profile (updated_at DESC);

ALTER TABLE public.research_user_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_user_profile FORCE  ROW LEVEL SECURITY;

-- Trigger to auto-update updated_at on UPDATE:
CREATE TRIGGER trg_research_user_profile_updated_at
  BEFORE UPDATE ON public.research_user_profile
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();  -- assumes existing helper; if not, @dev creates it as a separate additive migration
```

> **הערה ל-@dev:** אם הפונקציה `set_updated_at()` לא קיימת ב-DB הקיים — הוסף אותה כ-helper additive במיגרציה הזאת בלבד (היא לא נוגעת בטבלה קיימת).

### 4.5 Foreign-key & ownership note

`chat_id` הוא ה-ownership key היחיד. **בכוונה אין FK ל-טבלה `users`** כי אין כזו טבלה בריפו (single-user bot — `chat_id` מגיע מ-Telegram). דפוס זה תואם לטבלאות הקיימות (`memory`, `tasks`, וכו') לפי ה-`docs/security/01f-final-summary.md`.

### 4.6 RLS audit checklist (חובה לפני merge ל-main)

| Table | RLS ENABLE | FORCE RLS | Policies | Verified |
|---|---|---|---|---|
| `research_articles` | ✅ | ✅ | 0 | בעת Phase 4 (@dev) |
| `research_topics` | ✅ | ✅ | 0 | בעת Phase 4 |
| `research_blocked_log` | ✅ | ✅ | 0 | בעת Phase 4 |
| `research_user_profile` | ✅ | ✅ | 0 | בעת Phase 4 |

ה-script לאימות (להרצה ע"י @qa, מבוסס על מה שעבד ב-`docs/security/01f-final-summary.md`):

```bash
ANON_KEY="<from Supabase dashboard>"
URL="https://zxxcdvveezcjuwijwlab.supabase.co"
for table in research_articles research_topics research_blocked_log research_user_profile; do
  RESULT=$(curl -s "$URL/rest/v1/$table?select=*&limit=5" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY")
  [ "$RESULT" = "[]" ] && echo "✅ $table: BLOCKED" || echo "❌ $table: LEAKED → $RESULT"
done
```

---

## 5. Tool Definitions — EXTENDED Tier

כל הכלים בתת ה-EXTENDED tier (`bot/agent.js:386`). אפס תוספת ל-CORE.

### 5.1 `search_research`

```js
{
  name: 'search_research',
  description: 'מחקר CRPS מסונן רגשית. כותרת/נושא/רענון.',  // ≤ 15 מילים בעברית, מתאים לאילוץ Groq tokens
  parameters: {
    type: 'object',
    properties: {
      query:   { type: 'string', description: 'free-text query (Hebrew or English); optional' },
      topic:   { type: 'string', description: 'subscribed topic id; optional' },
      refresh: { type: 'boolean', description: 'bypass 6h cache; default false' }
    },
    required: []
  }
}
```

**Behavior:**
- אם `topic` מסופק וגם `query` — `topic` הוא הפילטר הראשי, `query` ממוקם בתוך הקריטריונים.
- אם שניהם ריקים — fallback ל-`research_user_profile.preferences.default_topics` או ברירת מחדל `["CRPS general"]`.
- חוזר עם 5 articles (per Q1: 3 Tier-1 + 2 Tier-2). אם פחות מ-3 Tier-1 זמינים — משלים מ-Tier-2 עד 5.
- מצרף disclaimer אם `last_disclaimer_seen < today_local_il` (per Q בסעיף 9.1).

**Output:**
```json
{
  "ok": true,
  "articles": [
    {
      "tier": 1,
      "title_he": "...",
      "title_en": "...",
      "summary_he": "...",
      "url": "https://...",
      "source": "pubmed",
      "published_at": "2026-04-15"
    }
  ],
  "blocked_count": 7,         // transparency: how many filtered this round
  "disclaimer_he": "..."       // present if first-of-day
}
```

### 5.2 `subscribe_research_topic`

```js
{
  name: 'subscribe_research_topic',
  description: 'מנוי לנושא CRPS — מילות מפתח לחיפוש.',
  parameters: {
    type: 'object',
    properties: {
      topic:    { type: 'string',  description: 'short label, e.g., "ketamine"' },
      keywords: { type: 'array',   items: { type: 'string' }, description: 'expansion search terms' },
      active:   { type: 'boolean', description: 'enable immediately; default true' }
    },
    required: ['topic']
  }
}
```

**Behavior:** upsert ל-`research_topics` per `(chat_id, topic)`. אם `keywords` חסר — adapter ינסה אקסטרקציה אוטומטית (Phase 4 detail).

### 5.3 `get_research_history`

```js
{
  name: 'get_research_history',
  description: 'מאמרים שכבר הוצגו — היסטוריה.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'default 10' }
    },
    required: []
  }
}
```

**Behavior:** SELECT מ-`research_articles WHERE surfaced_to_chat_id = $chat ORDER BY surfaced_at DESC LIMIT $limit`. נכון ל-Q4 (track-by-default).

### 5.4 `set_research_profile`

```js
{
  name: 'set_research_profile',
  description: 'עדכון פרופיל מחקר אישי — טיפולים והעדפות.',
  parameters: {
    type: 'object',
    properties: {
      profile_he:  { type: 'string',  description: 'free-text Hebrew profile' },
      treatments:  { type: 'array',   items: { type: 'string' }, description: 'structured list, e.g., ["DRG", "gabapentin"]' },
      preferences: { type: 'object',  description: 'flat key-value object, e.g., { "articles_per_call": 5 }' }
    },
    required: []
  }
}
```

**Behavior:** upsert ל-`research_user_profile` per `chat_id`. **חובה אישור משתמש לפני שינוי טיפולים** (per Q בסעיף 13) — `set_research_profile` מחזיר `confirmation_needed: true` אם מתבקש לשנות `treatments`, ומחכה לאישור הבוט בסיבוב הבא.

### 5.5 EXTENDED registration

ה-skill מייצא את 4 הכלים דרך `module.exports = { name, description, tools, execute }`. ה-loader (`bot/skills-loader.js:79–90`) משלב אותם אוטומטית ב-tool list של ה-agent. **המנגנון של CORE/EXTENDED קיים ב-`bot/agent.js:386` ועובד לפי קונבנציה — `@dev` יוודא שכל ה-4 הכלים הללו לא נכנסים ל-CORE list.**

**אם המנגנון דורש סימון מפורש (whitelist/blacklist) — STOP — Phase 4 escalation.** אני לא קראתי את כל `bot/agent.js`; ייתכן שהסימון אוטומטי (מה שיצא מ-skills loader → אוטומטית EXTENDED). זוהי שאלה פתוחה ל-Phase 3 (Q בסעיף 13).

---

## 6. Hope Filter — Implementation Spec

### 6.1 Two-stage pipeline

```
article candidate
       │
       ▼
┌──────────────────────┐
│ filter/keywords.js   │  ← deterministic, no LLM, ~1ms
│  block-list match    │
└─────┬────────┬───────┘
      │ pass    │ block
      │         └──→ research_blocked_log (blocked_by='pre_filter')
      ▼
┌──────────────────────┐
│ filter/classifier.js │  ← Gemini Flash, ~600 tokens
│  tier 1 / 2 / 3      │
└─────┬────┬────┬──────┘
      │1   │2   │3
      │    │    └──→ research_blocked_log (blocked_by='llm_classifier')
      │    └─────→ research_articles (tier=2, framing_he set)
      └──────────→ research_articles (tier=1)
```

### 6.2 Pre-filter blocklist — מוצע, **דורש אישור שילה לפני קוד** (per Q8 ב-01a)

הצעה ראשונית של 15 ביטויים. כל ביטוי → תרגום עברית מקביל אם רלוונטי.

| # | English | Hebrew | reason_code |
|---|---|---|---|
| 1 | suicide | התאבדות | `suicide_keyword` |
| 2 | suicidal ideation | מחשבות אובדניות | `suicide_keyword` |
| 3 | self-harm | פגיעה עצמית | `selfharm_keyword` |
| 4 | disability rate | אחוז נכות | `disability_stat` |
| 5 | mortality rate (in CRPS context) | תמותה | `mortality_stat` |
| 6 | "most painful condition" | "הכאב הנורא ביותר" | `extreme_framing` |
| 7 | "worst pain known to" | "הכאב החמור ביותר ש" | `extreme_framing` |
| 8 | amputation rates | אחוזי כריתה | `amputation_stat` |
| 9 | progressive disability | התקדמות נכות | `progression_pessimism` |
| 10 | terminal | סופני | `terminal_framing` |
| 11 | hopeless | חסר תקווה | `hopeless_framing` |
| 12 | irreversible damage | נזק בלתי הפיך | `irreversible_framing` |
| 13 | nothing works | "שום דבר לא עוזר" | `nihilism_framing` |
| 14 | reddit / r/CRPS | reddit | `forum_anecdote` |
| 15 | facebook group | קבוצת פייסבוק | `forum_anecdote` |

**הערה:** רשימה זו היא **"או"** — match של ביטוי אחד = block. ה-classifier (שלב 2) הוא לא יראה את המאמר. מותנה גם בקונטקסט: ביטוי כמו "amputation" יכול להופיע בהקשר חיובי ("avoiding amputation through new treatment") — לכן **שילה צריך לבדוק את הרשימה והרגש שלו לפני קיבוע**. כשתאשר — נקבע.

### 6.3 Classifier prompt — Gemini 2.5 Flash

הצעה מלאה לפרומפט. **כל המסמך הזה נחתם ע"י @dev ב-Phase 4 לפי משוב QA.**

```
SYSTEM:
You are an emotional-safety classifier for CRPS (Complex Regional Pain Syndrome)
research articles. Your output decides whether a chronic-pain patient sees an
article. Mistakes have real impact: surfacing scary content harms; over-blocking
hides hope. Be conservative when uncertain.

CONSTRAINTS (non-negotiable):
- Tier 3 = block. Tier 1 = surface. Tier 2 = surface with neutral framing.
- Tier 3 covers: prognosis pessimism, disability/mortality stats, suicide content,
  graphic pain descriptions, "most painful condition" framing, patient anecdotes
  from forums, content focused on side effects without the user asking.
- Tier 1 covers: new treatment positive results, recruiting clinical trials
  (especially in Israel), mechanism breakthroughs, regulatory approvals, positive
  remission/quality-of-life data, publications by tracked CRPS researchers.
- Tier 2 covers: mixed results, early-phase data, treatments with caveats,
  general reviews. Articles that challenge a treatment the user takes also go
  here with neutral framing — never block these.

LANGUAGE:
- "framing_he" must be Hebrew, ≤ 25 words, warm-but-honest tone.
- "rationale" must be English, ≤ 15 words, for internal logging.

OUTPUT (JSON only — no prose, no markdown fence):
{
  "tier": 1 | 2 | 3,
  "framing_he": "string | null",      // present iff tier=2
  "block_reason": "string | null",    // present iff tier=3, short stable code
  "rationale": "string"                // always present
}

USER:
Title: {title}
Abstract: {abstract}
Source: {source}
Published: {published_at}
User profile (for context — do NOT echo): {profile_he_or_blank}
User current treatments: {treatments_csv}

Classify.
```

### 6.4 JSON output validation

```js
// schema enforced at filter/classifier.js boundary
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    tier:         { type: 'integer', enum: [1, 2, 3] },
    framing_he:   { type: ['string', 'null'], maxLength: 200 },
    block_reason: { type: ['string', 'null'], maxLength: 80 },
    rationale:    { type: 'string',  maxLength: 200 }
  },
  required: ['tier', 'rationale']
};

// validation rules:
// - tier === 1 → framing_he must be null, block_reason must be null
// - tier === 2 → framing_he must be non-empty Hebrew string, block_reason null
// - tier === 3 → block_reason must be non-empty short code, framing_he null
// - any violation → coerce to tier 3 with block_reason='schema_violation' (fail-safe)
```

**הצדקה ל-fail-safe:** אם המסווג מחזיר JSON לא תקין → ברירת המחדל היא חסימה, לא הצגה. מאמרים אבודים עדיף על מאמרים מסוכנים.

### 6.5 Token budget

| Component | Tokens (typical) |
|---|---|
| System prompt | ~250 |
| User prompt skeleton | ~30 |
| Article title | ~20 |
| Article abstract | ~250 (truncated to 1500 chars upstream) |
| User profile (when sent) | ~80 |
| Treatments list | ~20 |
| **Total input** | **~650** |
| Output JSON | **~80** |
| **Grand total per article** | **~730 tokens** |

**Cost estimate (Gemini 2.5 Flash pricing — verify in Phase 4):**
- $0.075/M input + $0.30/M output
- per article: $0.000049 + $0.000024 = **$0.000073**
- 100 articles/חודש: **$0.0073/חודש** — בתחזית טוב ב-free tier הקיים

### 6.6 Caching the classifier output

`research_articles.tier`, `framing_he`, `classifier_rationale` מאוחסנים → קריאה חוזרת לאותו מאמר לא מפעילה LLM שוב. dedup לפי `(source, source_id)` UNIQUE. אם מאמר עודכן ב-source (rare), `fetched_at` יתעדכן אבל הסיווג נשמר אלא אם flag ידני בעת dev.

---

## 7. Source Adapter Contracts

כל source adapter ב-`skills/research/sources/` חייב לייצא את הממשק הבא:

```js
/**
 * @typedef {Object} Article
 * @property {string} source       — 'pubmed' | 'clinicaltrials' | 'medrxiv'
 * @property {string} source_id    — adapter-specific stable id
 * @property {string} title
 * @property {string|null} abstract
 * @property {string} url
 * @property {string[]} authors
 * @property {string|null} published_at — ISO 8601
 */

/**
 * @typedef {Object} SourceAdapter
 * @property {string} name                                 — must match source enum in DDL
 * @property {(query: string, since: Date) => Promise<Article[]>} fetch
 * @property {(article: Article) => string} parseId        — returns source_id
 * @property {{ requestsPerSecond: number, burst: number }} rateLimit
 * @property {() => Promise<boolean>} healthCheck          — quick endpoint ping
 */
```

### 7.1 PubMed adapter — concrete sketch

```js
// skills/research/sources/pubmed.js
const NCBI_API_KEY = process.env.NCBI_API_KEY; // optional; raises rate from 3→10 req/sec
const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

module.exports = {
  name: 'pubmed',
  rateLimit: NCBI_API_KEY ? { requestsPerSecond: 10, burst: 20 } : { requestsPerSecond: 3, burst: 5 },

  async fetch(query, since) {
    // 1. esearch — get PMIDs matching query + date filter
    // 2. efetch — pull XML metadata for those PMIDs
    // 3. parse XML → Article[]
    // (full implementation in Phase 4)
  },

  parseId(article) {
    // PMID is the stable id
    return article.source_id;
  },

  async healthCheck() {
    // GET /einfo.fcgi?db=pubmed&retmode=json — confirms endpoint reachable
  }
};
```

**Per-adapter tests required (Phase 4 QA):** `fetch` returns >=1 article on a known query; `parseId` is stable; `healthCheck` returns true on production endpoint.

### 7.2 Adapters in MVP scope

| Adapter | Base URL | Auth | MVP? |
|---|---|---|---|
| pubmed | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | optional `NCBI_API_KEY` | ✅ |
| clinicaltrials | `https://clinicaltrials.gov/api/v2` | none | ✅ |
| medrxiv | `https://api.medrxiv.org` | none | ✅ |
| RSDSA RSS | TBD (per 01a §1.3) | none | ❌ Phase 5 |
| Cochrane | no public API | n/a | ❌ Phase 5+ |
| משרד הבריאות | scraping | n/a | ❌ Phase 5+ |

---

## 8. Risk Analysis

| # | Threat | Likelihood | Impact | Mitigation | Rollback Cost |
|---|---|---|---|---|---|
| R1 | מסווג Gemini hallucinates — מסווג מאמר Tier-3 כ-Tier-1 → שילה רואה תוכן אסור | Med | High — פגיעה ב-emotional safety | (a) pre-filter דטרמיניסטי לפני LLM; (b) JSON schema enforcement עם fail-safe ל-tier 3 בעת violation; (c) `research_blocked_log` שקוף — שילה יכול לסקור ולכוון. | Low — שילה מסמן את המאמר כ-misclassified; @dev מוסיף keyword ל-pre-filter; אין rollback של DB |
| R2 | PubMed/CT.gov rate-limit אותנו — `/research` נופל | Low | Med — הפיצ'ר זמני לא עובד | (a) cache 6h לפי Q2; (b) optional `NCBI_API_KEY` מכפיל את ה-rate; (c) graceful degradation: אם adapter אחד נופל, השניים האחרים ממשיכים | Zero — ממתינים ל-rate window; אין צורך בקוד |
| R3 | Source adapter שובר (CT.gov v2 משנה schema) | Low-Med | Med — adapter מפסיק להחזיר תוצאות | (a) `healthCheck()` רץ לפני `fetch()`, נכשל מהר עם הודעה ברורה; (b) per-adapter unit tests ב-CI מציפים breaking change; (c) ה-Hope Filter לא תלוי ב-source — מאמרים מ-PubMed/medRxiv ממשיכים | Zero — disable adapter ב-`sources/index.js` registry; @dev מתקן בנפרד |
| R4 | תרגום עברית ע"י Gemini באיכות נמוכה — שילה מקבל ניסוח מבלבל | Med | Low — אסטטית; לא בטיחותית | (a) glossary-he.js מבטיח עקביות מונחים רפואיים; (b) `title_en` תמיד נכלל בתשובה (per Q3 dual-lang) — ה-fallback קריא | Zero — שילה תמיד יכול לראות את המקור באנגלית |
| R5 | `research_articles` גדל בלי גבול — DB bloat | Low (single-user) | Low | (a) פונקציית cleanup רבעונית: drop אחרי 1 שנה אם `surfaced_to_chat_id IS NULL`; (b) מומלץ ל-Phase 5 לאחר הצטברות נתונים אמיתית | Low — DELETE on-demand |
| R6 | `@dev` שוכח ENABLE/FORCE RLS על טבלה חדשה — דליפת PHI | Low | **Critical** — דליפת פרופיל רפואי | (a) DDL בסעיף 4 מכיל את ה-RLS clauses; (b) §4.6 audit checklist רץ ע"י @qa לפני merge; (c) Supabase Advisor בודק `rls_disabled_in_public` automatically — alert ב-email | Med — `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` retroactively; אבל בחלון בין creation ל-fix הנתונים פתוחים. **ה-mitigation חייב למנוע את החלון הזה.** |
| R7 | תקציב טוקנים מתפוצץ — abstract ארוך מאוד (משלוש פסקאות) → 3K טוקנים במקום 250 | Low | Low — עלות $0.10 לבמקום $0.007 | (a) truncation upstream ל-1500 chars; (b) Gemini Flash quota מוצף בעיצומה — אבל monitor נחוץ | Zero — שינוי ל-cap |
| R8 | פרופיל המטופל אבוד (DB restore רע, או יוזר drop) → שילה צריך להזין מחדש | Very Low | Low | (a) `bot/backup.js` הקיים יכלול את הטבלה החדשה אוטומטית? **STOP — בדיקה ל-Phase 4: האם backup.js רץ generic על כל הטבלאות, או על רשימה היפוטרצית?** | Med — אם backup לא רץ, fix ב-Phase 4 |
| R9 | pre-filter false-positive — מאמר legit על "avoiding amputation through neridronate" נחסם בגלל "amputation" | Med | Med — מאבד מאמר חיובי | (a) `research_blocked_log` עם reason_code לסקירה ידנית של שילה; (b) אם false-positive חוזר — שילה מסיר את ה-keyword מהרשימה; (c) ב-Phase 5 אפשר להוסיף contextual matching | Low — keyword removal |
| R10 | משתמש קורא ל-`set_research_profile` עם treatments חדשים עם typos ("gabapentine" במקום "gabapentin") → topics לא matches | Med | Low | (a) הכלי מחזיר confirmation message בעברית עם הערכים המוצעים לפני שמירה; (b) glossary-he.js מתעדכן עם variants | Zero — re-set |
| R11 | פיצ'ר דורש שינוי ב-`bot/index.js` (slash command routing דורש hook ידני) | Med (אם המנגנון דורש זאת) | **Hard-constraint violation** | (a) Phase 3 (PM) יבדוק את `bot/telegram.js` slash routing לפני design freeze; (b) אם slash routing הוא generic — אפס שינוי ב-`bot/index.js`; (c) אם נדרש hook → STOP — escalation לשילה לאישור | Zero (אם ה-routing הוא generic); High (אם נדרש שינוי — אסקלציה) |
| R12 | Concurrent `/research` משני clients (telegram-web + telegram-mobile) → race על `surfaced_to_chat_id` upsert | Very Low (single user, lazy lookups) | Low | UNIQUE constraint על `(source, source_id)` מבטיח אטומיות ב-upsert | Zero |
| R13 | classifier מחזיר `tier=2` אבל `framing_he` ריק — מאמר מוצג בלי הקשר | Low (validated) | Low | schema validation מאלץ `framing_he` כ-non-empty כש-tier=2; coerce ל-tier=3 fail-safe | Zero |
| R14 | הוספת `NCBI_API_KEY` כ-env-var תיכשל ב-deploy אם Render לא מסונכרן | Low | Very Low | adapter עובד גם בלי key (rate נמוך אבל פעיל); env-var optional | Zero |

**14 risks documented**, 8+ as required by brief.

---

## 9. QA Test Plan (for Phase 5)

### 9.1 Unit tests per source adapter

| Adapter | Test cases |
|---|---|
| pubmed | (a) `fetch("CRPS", 30 days ago)` returns ≥ 1 article; (b) `parseId` returns stable PMID; (c) `healthCheck` returns true; (d) malformed XML → throws explicit error, not silent empty array |
| clinicaltrials | (a) `fetch("CRPS", _)` filtered to `country=Israel` returns ≥ 0 (allow zero — recruitment varies); (b) NCT id stable; (c) v2 endpoint reachable |
| medrxiv | (a) `fetch("CRPS", _)` returns array (potentially empty — preprints rare); (b) doi as id; (c) rate limit honored |

Mock HTTP responses ב-`tests/fixtures/<adapter>/` כדי שטסטים לא תלויים באינטרנט.

### 9.2 Integration test — full flow

```
GIVEN: clean DB, profile_he set, no surfaced articles
WHEN:  search_research(query: "ketamine")
THEN:
  (a) at least one article returned (or graceful "no new articles" message)
  (b) all returned articles have tier ∈ {1, 2}
  (c) all Tier-2 articles have non-empty framing_he
  (d) blocked_count > 0 only if pre-filter or LLM blocked something this round
  (e) research_blocked_log has 0 rows that match Tier-1 articles (sanity)
  (f) disclaimer_he present (first call of day)
```

### 9.3 Hope Filter verification — 10 fixtures

קבוצה של 10 כותרות+תקצירי מאמרים מוצעים, כל אחד עם `expected_tier`. הטסט מריץ את ה-classifier (real Gemini call) ובודק התאמה.

| # | Title | Expected tier | Reason |
|---|---|---|---|
| 1 | "Phase 2 RCT: low-dose naltrexone reduces CRPS pain by 38%" | 1 | Treatment-positive RCT |
| 2 | "Recruiting: pulsed RF for refractory CRPS at Sheba" | 1 | Recruiting trial in IL |
| 3 | "Mixed results for ketamine infusion in CRPS: 50% responder rate" | 2 | Mixed results |
| 4 | "Pilot study: VNS in 12 CRPS patients shows preliminary improvement" | 2 | Early-phase, small N |
| 5 | "Suicide risk in CRPS patients: a population study" | 3 | Suicide content |
| 6 | "CRPS: the most painful condition known to medicine — a review" | 3 | Extreme framing |
| 7 | "Long-term disability outcomes in CRPS — 10-year follow-up" | 3 | Disability stats |
| 8 | "Patient experiences with CRPS — narratives from r/CRPS" | 3 | Forum anecdotes |
| 9 | "Mechanism of CRPS clarified: small fiber neuropathy involvement" | 1 | Mechanism breakthrough |
| 10 | "DRG stimulation long-term outcomes — challenges and refinements" | 2 | Challenges existing treatment (Shilo's), neutral framing |

**Pass criterion:** ≥ 9/10 match; if 1 disagreement, manual review with @qa.

### 9.4 Hebrew translation quality spot-check

5 מאמרים אקראיים מ-9.2 → תרגום `summary_he` נבדק ידנית:
- מילון רפואי עקבי (`gabapentin` → "גבפנטין", לא "גאבא"-משהו)
- Tone warm-but-honest (per Q7)
- אין סלנג רפואי לא-מוסבר
- אורך ≤ 50 מילים בעברית

### 9.5 Pre-filter blocklist verification

15 ביטויים → 15 fixture articles → כל אחד נחסם → `research_blocked_log` יוצג עם reason_code נכון.

### 9.6 Schema + RLS verification

ראה §4.6 — סקריפט bash שמוודא anon לא יכול לקרוא טבלה חדשה.

### 9.7 Smoke test — Telegram

| Test ID | Action | Expected |
|---|---|---|
| RT01 | שילה: "/research" | Bot מחזיר 5 articles + disclaimer (פעם ראשונה ביום) |
| RT02 | שילה: "/research --refresh" | Bot מתעלם מ-cache, מבצע fetch חדש |
| RT03 | שילה: "תרשום אותי לנושא ketamine" | Bot מאשר subscription |
| RT04 | שילה: "מה כבר ראיתי?" | Bot מחזיר היסטוריה |
| RT05 | שילה: "תעדכן את הפרופיל שלי — DRG ו-gabapentin" | Bot מאשר עם confirmation message |
| RT06 | שילה (יום למחרת): "/research" | Bot לא מציג שוב את המאמרים מיום קודם (track-by-default) |

---

## 10. Rollback Plan

### 10.1 Rollback A — Disable skill (full feature off, instant)

```bash
mv skills/research skills/_disabled_research
git commit -am "research: disable skill (rollback)"
git push origin <branch>
# Render auto-redeploys
```

**Effect:** loader דולג על תיקייה עם `_` קידומת. ה-tools לא נרשמים. הבוט לא יודע על `/research`. **אפס איבוד נתונים** — הטבלאות נשארות.

**Cost:** 30 שניות. שימוש: כשהפיצ'ר מתנהג רע ובינתיים רוצים לעצור.

### 10.2 Rollback B — Disable specific adapter

```js
// skills/research/sources/index.js
const adapters = {
  pubmed: require('./pubmed'),
  // clinicaltrials: require('./clinicaltrials'),  // disabled — rollback
  medrxiv: require('./medrxiv')
};
```

**Effect:** ה-skill ממשיך לעבוד עם 2 adapters. שילה מקבל פחות מקורות אבל ה-flow תקין.

**Cost:** דקה. שימוש: כש-source spec משתנה ושוברנו זמנית.

### 10.3 Rollback C — Revert all code

```bash
git revert <dev-commits>
git push
```

**Effect:** הקוד חוזר ל-pre-Phase-4. הטבלאות נשארות עם הנתונים. השלב הבא: אפשר לבחור drop ידני או להשאיר את הטבלאות לשימוש עתידי.

**Cost:** Low. שימוש: כשהפיצ'ר נכשל מהותית ורוצים לחזור לאחור מבני.

### 10.4 Rollback D — Drop tables (data loss — LAST RESORT)

```sql
DROP TABLE public.research_articles;
DROP TABLE public.research_topics;
DROP TABLE public.research_blocked_log;
DROP TABLE public.research_user_profile;
```

**Effect:** **כל הנתונים נמחקים.** פרופיל שילה אבוד. אם הוא הוזן ידנית — צריך לחזור עליו.

**Cost:** High (data loss). שימוש: רק אם schema design גורם לבעיה ולא ניתן לפתור in-place.

**ברירת המחדל:** לא לעבור Rollback D. אם A/B/C לא מספיקים — לעצור ולהסלים.

### 10.5 Trigger conditions (when to rollback)

| Condition | Recommended action |
|---|---|
| Hope Filter מסווג Tier-3 כ-Tier-1 פעם אחת | Rollback B (disable LLM stage), continue with pre-filter only; investigate prompt |
| Pre-filter false-positives גבוהים (>20% של טסטים) | Adjust blocklist, no full rollback |
| Adapter שובר (HTTP 5xx >50%) | Rollback B for that adapter |
| Render deploy נופל | Rollback A (disable skill) |
| Critical privacy bug (RLS לא enforced על טבלה חדשה) | **STOP all writes** + Rollback A immediately + post-mortem |

---

## 11. Migration Delivery Decision

שתי אופציות (Mary העלתה ב-01a §5.5):

### Option (a) — Continue Supabase MCP (existing pattern)

`@dev` מבצע את ה-DDL דרך Supabase MCP בעת Phase 4. אין קבצים ב-repo.

| Aspect | Detail |
|---|---|
| Audit trail | בדוקיו של MCP + ב-`docs/research/` (this file + 01c) |
| Repo footprint | אפס — אין `supabase/migrations/` |
| Methodology | תואם ל-`docs/security/` work |
| Disaster recovery | הסכימה תיכלל ב-DB backup (`bot/backup.js` או Supabase native) |

### Option (b) — Introduce `supabase/migrations/`

יצירת תיקייה חדשה `supabase/migrations/`, קובץ `2026-05-XX-<feature>.sql` עם ה-DDL.

| Aspect | Detail |
|---|---|
| Audit trail | קוד מקור הוא source-of-truth |
| Repo footprint | תיקייה חדשה (אדיטיבי — לא משנה קיים) |
| Methodology | **שינוי גישה** — שונה מהדפוס הקיים |
| Disaster recovery | אפשר re-apply בקלות (sql files in repo) |

### Recommendation: **Option (a)** for this work + **schedule (b) as Phase 5+ improvement**

נימוקים:
1. **שמירה על אדיטיביות** — הוספת תיקייה ב-top level היא "אדיטיבית טכנית" אבל **שינוי methodology** הוא רוחבי. עדיף לעשות זאת בעבודה ייעודית, לא בשלב הזה.
2. **Consistency עם 01f** — הציפייה היא Continuity (אותה דרך עבור עבודה דומה).
3. **Future improvement מתועד** — שילה רושם ב-memory את הצורך לעבור ל-(b) באופן מסודר אחר כך.

**STOP escalation:** אם שילה מעדיף (b) עכשיו — Q בסעיף 13.

---

## 12. Additive-Only Re-Verification

מאמת מחדש את ההתחייבות מ-01a §8 — הפעם אחרי שראיתי את כל ה-design:

### 12.1 `bot/index.js`
- **0 שינויים מתוכננים.** ה-skill נטען אוטומטית דרך `bot/skills-loader.js`. ה-tools משולבים ב-EXTENDED אוטומטית.
- **Conditional STOP:** אם `bot/agent.js` (CORE/EXTENDED split ב-line 386) דורש סימון מפורש של tools חדשים כ-EXTENDED — Phase 4 STOP escalation. מנגנון לא נסקר עד הסוף.

### 12.2 משתני env
- `NCBI_API_KEY` — **אופציונלי**. ה-adapter עובד גם בלי. אדיטיבי בלבד.
- אפס שינוי ל-`SUPABASE_*`, `GROQ_*`, `GEMINI_*`, `TELEGRAM_*`, `GOOGLE_*`.
- `.env.example` יקבל שורה אחת (`NCBI_API_KEY=optional`) — תוספת בלבד.

### 12.3 Cron jobs
- **0 חדשים.** הפיצ'ר on-demand בלבד. כל ה-12 cron jobs הקיימים (`bot/scheduler.js`, `bot/proactive.js`, `bot/index.js`) נשארים כמות-שהם.

### 12.4 טבלאות קיימות
- **אפס שינוי schema.** 4 טבלאות חדשות בלבד.
- אזהרת stop: אם Phase 4 יראה ש-`bot/backup.js` לא רץ generic על כל הטבלאות → ייתכן שצריך להוסיף את 4 הטבלאות החדשות לרשימה. **זוהי תוספת לקובץ קיים**. STOP — escalation.

### 12.5 `bot/supabase.js`
- **לא נוגע.** ה-skill ייקרא ל-`require('../bot/supabase')` ויירש את ה-client הקיים (service_role).

### 12.6 כלי CORE
- **0 שינויים.** 4 הכלים החדשים נכנסים ל-EXTENDED בלבד.

### 12.7 קבצים מלוכלכים קיימים
- `bot/image-editor.js, data/expenses.json, data/health-log.json, data/tasks.json, data/habits.json, data/passwords.json, data/stock-watchlist.json` — נותרים unstaged בכל commit של Phase 4.

### 12.8 Skills קיימים
- `news/`, `vision/`, `voice/`, `web-search/` — אפס שינוי. אין conflict בשמות tool (`search_research` ≠ `web_search`).

### 12.9 STOP-list active checkpoints

מ-01a §8.9, מצבים שדורשים escalation. בעקבות ה-design:

| # | Trigger | Status |
|---|---|---|
| 1 | שינוי schema של טבלה קיימת | ❌ לא מתוכנן |
| 2 | שינוי mechanism של loader/routing קיים | ❌ לא מתוכנן (אבל R11 דורש בדיקה ב-Phase 3) |
| 3 | שדרוג גרסת `@supabase/supabase-js` | ❌ לא מתוכנן |
| 4 | שינוי ב-system prompt הראשי של הבוט | ❌ לא מתוכנן |
| 5 | הוספת cron job | ❌ לא מתוכנן |
| 6 | שינוי `bot/supabase.js` | ❌ לא מתוכנן |
| 7 | שינוי `bot/agent.js` בקטע ה-CORE/EXTENDED | ⚠️ צריך לוודא ב-Phase 3 שלא נדרש (R11) |

---

## 13. Open Questions for Shilo (gating לפני Phase 3)

### Q15 — Pre-filter blocklist אישור
הצעתי 15 ביטויים בסעיף 6.2. בקשתי בעברית: עבור על הרשימה, סמן כל ביטוי שאתה רוצה להשמיט/להוסיף. אם הכל בסדר — תאשר "blocklist OK".

### Q16 — Migration delivery: (a) or (b)?
המלצתי (a) — Supabase MCP בלבד, ללא `supabase/migrations/` בריפו. אם אתה מעדיף (b) — תגיד עכשיו ואני אעדכן את התכנון.

### Q17 — `bot/agent.js` CORE/EXTENDED — מנגנון
האם שילוב tools חדשים מ-skill loader הוא:
- **(a)** אוטומטי כ-EXTENDED (אנחנו מקווים)
- **(b)** דורש סימון/whitelist מפורש בקוד הבוט

ב-Phase 3 (PM/PRD) אני צריך מהמסמכים שלך אישור על (a). אם זה (b) — STOP.

### Q18 — `bot/backup.js` כיסוי טבלאות חדשות
האם ה-backup הקיים רץ generic על כל הטבלאות הציבוריות, או על רשימה מקודדת? אם הראשון — אדיטיבי-לחלוטין. אם השני — Phase 4 דורש תוספת שורה לרשימה (תוספת לקובץ קיים = stop-list #2 trigger; דורש אישור).

### Q19 — Disclaimer cadence
ההצעה: disclaimer מוצג בקריאה הראשונה של היום. אלטרנטיבות:
- **(a)** פעם ביום (מומלץ)
- **(b)** פעם בשבוע
- **(c)** רק בקריאה הראשונה אי-פעם
- **(d)** בכל קריאה

### Q20 — Confirmation לפני שינוי טיפולים בפרופיל
ה-tool `set_research_profile` מבקש אישור לפני שמירת `treatments` חדשים. האם:
- **(a)** אישור תמיד (מומלץ — מונע typos)
- **(b)** רק כשמוסיפים (delete בלי אישור)
- **(c)** בלי אישור — שמירה ישירה

### Q21 — Gemini model — Flash vs Pro
ההצעה Flash. אבל ל-classifier emotional safety, איכות חשובה. האם רוצה לשקול Pro?
- **(a)** Flash (מומלץ — מספיק טוב, חוסך טוקנים)
- **(b)** Pro (יותר יקר ~10x; יותר רגיש)
- **(c)** Flash בברירת מחדל + escalate ל-Pro אם classifier מסווג Tier-2 (מקרי גבול)

### Q22 — Citation logging
האם לשמור ב-DB אילו מאמרים שילה לחץ על הלינק? (אנליטיקה — שיפור ה-tier rules)
- **(a)** כן (מומלץ — שיפור איטרטיבי)
- **(b)** לא (פרטיות מקסימלית)

### Q23 — Retention period — `research_blocked_log`
**(a)** לתמיד; **(b)** 1 שנה; **(c)** 6 חודשים

### Q24 — Max abstract length לפני truncation
ההצעה: 1500 chars. נותן ~250 tokens. האם:
- **(a)** 1500 (מומלץ)
- **(b)** 1000 (חיסכון)
- **(c)** 2500 (איכות מקסימלית, ~$0.011/חודש)

### Q25 — שילוב חוקרים-מועדפים (Mary §1.5)
האם רוצים יישום מיידי של "publication by tracked researcher → Tier-1 even if neutral title"?
- **(a)** כן ב-MVP
- **(b)** Phase 5

---

## Handoff Note ל-Phase 3 (PM / PRD)

המסמך הזה **אינו משנה דבר בקוד**. הוא הצעת תכנון בלעדה.

**מוכן ל-Phase 3 כאשר:**
- שילה מאשר את ההמלצה הראשית (Option D) — או דורש שינוי
- שילה עונה על Q15–Q25 (או נותן סמכות ל-PM להחליט עם defaults של Winston)
- שילה מאשר את ה-blocklist (Q15)

**מה עוד לא מתוכנן (בכוונה — Phase 3 territory):**
- AC (Acceptance Criteria) פורמליים לכל tool
- מבנה ה-PRD eveningו
- timeline לפיצ'ר
- assignments

**Hard constraints — restated:**
- Feature 100% additive — re-verified §12
- Zero changes to existing skills/tables/scheduler/supabase.js/agent CORE
- New tables MUST have `ENABLE` + `FORCE` RLS in same migration (per `docs/security/01f` Rule 1)
- Pre-existing dirty files stay unstaged through all phases
- Emotional safety constraints from original brief carried forward into pre-filter + classifier prompt

— Winston 🏗️
