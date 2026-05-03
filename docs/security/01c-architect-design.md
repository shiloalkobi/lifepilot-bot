# Sub-Phase 1.5.2 — Architect Design: anon → service_role Migration

| Field | Value |
|---|---|
| Author | Winston — BMAD System Architect (🏗️) |
| Date | 2026-04-30 |
| Mode | DESIGN ONLY — no source files touched |
| Branch | `security/enable-rls-lockdown` |
| Predecessor | `01b-analyst-findings.md` (approved) |
| Successor (gated) | Sub-Phase 1.5.3 — `@dev` implementation |
| Risk class | Low (single-file change, fallback preserved, env-first deploy) |

---

## TL;DR — תקציר מנהלים

- **המלצה: Option A** — single-var resolution: `SUPABASE_KEY = SERVICE_ROLE_KEY || ANON_KEY`. שינוי של 6 שורות ב-`bot/supabase.js`, 6 שורות ב-`.env.example`, אפס שינויים בכל 14 הצרכנים.
- **סדר deploy: env-first.** קודם להוסיף את `SUPABASE_SERVICE_ROLE_KEY` ב-Render → ה-redeploy האוטומטי משאיר את הבוט עובד על anon (ה-fallback) → @dev דוחף את הקוד החדש → redeploy שני מרים את הבוט על service_role. רולבק = פשוט revert של ה-deploy. ה-env var הקיים נשאר עד שלב 3 ייצב.
- **לוג ה-startup הופך ל-source of truth** לאיזה role רץ. `[Supabase] Connected ✅ — auth role: service_role` או `... — auth role: anon (FALLBACK — set SUPABASE_SERVICE_ROLE_KEY)`. אין הדפסת מפתח, אין דליפה.
- **משטח הסיכון:** הצרכן הקריטי ביותר הוא `bot/agent-memory.js` (memory בכל הודעה — נראה רגרסיה תוך שניות). הצרכן הרחב ביותר הוא `bot/metrics-history.js` (5 טבלאות).
- **Rollback path מוצפן בקוד עצמו** — אם ה-env החדש חסר, הבוט נופל אוטומטית ל-anon ומדפיס לוג מפורש. זה safety net מובנה, לא אופטימיזציה.

---

## 1. Brainstorm — Alternatives Considered

### Option A — Single-var resolution with anon fallback ⭐ (recommended)

הקוד קורא `SUPABASE_SERVICE_ROLE_KEY` קודם, ואם הוא לא קיים — נופל ל-`SUPABASE_ANON_KEY`. משתנה אחד (`SUPABASE_KEY`) משמש את ה-`createClient`. ה-`role` נגזר מאיזה var נמצא ומודפס לסטרט-לוג.

| Aspect | Detail |
|---|---|
| Lines changed (code) | ~6 |
| Lines changed (env doc) | ~6 |
| New env vars on Render | 1 (`SUPABASE_SERVICE_ROLE_KEY`) |
| Consumer files touched | 0 (כולם ממשיכים `require('./supabase')`) |
| Failure mode if SERVICE_ROLE missing | falls back to anon + clear FALLBACK warning log |
| Failure mode if both missing | same as today: graceful "Not configured — using JSON fallback" |
| Risk level | **Low** — הסטייט מרחב הסיכון תואם לסטייט הנוכחי (anon עובד) |
| Blast radius if it fails | Zero new — אם ה-SERVICE_ROLE שגוי או חסר, הבוט נופל ל-anon וממשיך לעבוד (אבל RLS עוד OFF, אז עדיין פונקציונלי) |

### Option B — Explicit two-var with named flag

קוד קורא **שני** משתנים בנפרד, ויש משתנה boolean נפרד (`SUPABASE_USE_SERVICE_ROLE=true|false`) שקובע. כך שילה צריך לעדכן 2 משתנים ב-Render: גם את ה-key החדש וגם flag.

| Aspect | Detail |
|---|---|
| Lines changed (code) | ~12 |
| Lines changed (env doc) | ~10 |
| New env vars on Render | 2 |
| Pros | מאוד מפורש; אפשר לבחות role ידנית ללא קשר למה שיש |
| Cons | יותר משטח לטעות אנוש (flag נשכח, role לא תואם key); לא פותר בעיה אמיתית — נוכחות של SERVICE_ROLE_KEY כבר אומרת "השתמש בי" |
| Risk level | Low-Med — flag misalignment הוא bug שקט |
| Blast radius if it fails | Higher — אם ה-flag נשאר false אחרי הוספת ה-key, מקבלים illusion של מעבר אבל הבוט עדיין anon |

**נדחה** כי הפלאג הוא משטח שגיאה ללא תועלת — אם המפתח החדש בקובץ הסביבה, ברור שצריך להשתמש בו.

### Option C — Wrapper module abstraction

קובץ חדש `bot/supabase-config.js` שמייצא `{ url, key, role }`, ו-`bot/supabase.js` משתמש בו.

| Aspect | Detail |
|---|---|
| Lines changed (code) | ~25 (מודול חדש + עדכון לקובץ הקיים) |
| New files | 1 |
| Consumer files touched | 0 |
| Pros | testability טוב יותר; יותר קל להוסיף איכויות future (multi-tenant, key rotation hooks) |
| Cons | over-engineering לקוד קיים של 22 שורות; המודול הקיים כבר פשוט מספיק; עוד קובץ אחד = עוד surface ל-review |
| Risk level | Low (הלוגיקה זהה ל-A) |
| Blast radius if it fails | Same as A |

**נדחה** כי הפרויקט קטן, הקובץ קיים ופשוט, ואין דרישת testability עוד. שכבת abstraction תוסיף קוד בלי תועלת מיידית.

### Option D — Hard-fail if SERVICE_ROLE missing (mentioned for completeness)

לבטל את ה-fallback ל-anon לחלוטין. אם `SUPABASE_SERVICE_ROLE_KEY` חסר → הבוט נופל בהפעלה (`process.exit(1)`).

| Aspect | Detail |
|---|---|
| Pros | מונע שכחה של env על Render |
| Cons | **סותר במפורש את Hard Constraint #4 של המשתמש** ("Keep anon fallback — protects against deployment mistakes") |
| Risk level | High — נפילת בוט בעקבות Render ENV typo או clear-by-mistake |

**נדחה** מיידית — מנוגד להחלטת המשתמש.

---

## 2. Decision

**Option A — single-var resolution with anon fallback.**

נימוקים:
1. **Minimum surface area** — שינוי קוד מקומי, אפס שינויים ב-14 הצרכנים. ה-API של המודול (`{ supabase, isEnabled }`) לא משתנה.
2. **Fallback מובנה** — עומד ב-Hard Constraint #4. אם בעת ה-deploy שילה שכח להוסיף את ה-env, הבוט עדיין רץ.
3. **Observability דרך לוג** — אפשר לאמת מ-Render logs בלי גישה לקוד שאיזה role בפועל נמצא בשימוש. זה גם safety net לזיהוי "התחלפנו לאחור" (אם ה-env נמחק בטעות, הלוג יציג FALLBACK ושילה יראה את זה).
4. **Reversible deploy** — env-first ordering מאפשר רולבק על-ידי revert של commit הקוד בלבד. לא צריך לגעת ב-env.
5. **Boring technology** — בחירת default ב-JS דרך `||` היא pattern מוכר ב-Node, אין כלי חדש או library חדש.

נדחה: B, C, D — מפורט בסעיף 1.

---

## 3. Proposed Diffs (markdown only — no source written)

### 3.1 `bot/supabase.js`

**Before** (current — 22 lines):

```js
'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  console.log('[Supabase] Connected ✅');
} else {
  console.log('[Supabase] Not configured — using JSON fallback');
}

function isEnabled() {
  return supabase !== null;
}

module.exports = { supabase, isEnabled };
```

**After** (target — 28 lines):

```js
'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY;

const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const ROLE         = SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
  if (ROLE === 'service_role') {
    console.log('[Supabase] Connected ✅ — auth role: service_role');
  } else {
    console.log('[Supabase] Connected ✅ — auth role: anon (FALLBACK — set SUPABASE_SERVICE_ROLE_KEY)');
  }
} else {
  console.log('[Supabase] Not configured — using JSON fallback');
}

function isEnabled() {
  return supabase !== null;
}

module.exports = { supabase, isEnabled };
```

**Unified diff:**

```diff
--- a/bot/supabase.js
+++ b/bot/supabase.js
@@ -1,22 +1,28 @@
 'use strict';
 
 const { createClient } = require('@supabase/supabase-js');
 
-const SUPABASE_URL      = process.env.SUPABASE_URL;
-const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
+const SUPABASE_URL              = process.env.SUPABASE_URL;
+const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
+const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY;
+
+const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
+const ROLE         = SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon';
 
 let supabase = null;
-if (SUPABASE_URL && SUPABASE_ANON_KEY) {
-  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
+if (SUPABASE_URL && SUPABASE_KEY) {
+  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
     auth: { persistSession: false },
   });
-  console.log('[Supabase] Connected ✅');
+  if (ROLE === 'service_role') {
+    console.log('[Supabase] Connected ✅ — auth role: service_role');
+  } else {
+    console.log('[Supabase] Connected ✅ — auth role: anon (FALLBACK — set SUPABASE_SERVICE_ROLE_KEY)');
+  }
 } else {
   console.log('[Supabase] Not configured — using JSON fallback');
 }
 
 function isEnabled() {
   return supabase !== null;
 }
 
 module.exports = { supabase, isEnabled };
```

**Style verification (matches existing):**
- `'use strict';` retained at top.
- Single quotes throughout.
- Semicolons present.
- 2-space indent.
- Aligned `const` declarations (note: `SUPABASE_URL` line padding adjusted to align with the longest of the three — `SUPABASE_SERVICE_ROLE_KEY`).
- Emoji-friendly logs (`✅`).
- No JSDoc, no comments — matching the original's commentless style.
- `module.exports` shape unchanged: `{ supabase, isEnabled }`.

### 3.2 `.env.example`

**Before** (current — 4 lines):

```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
GROQ_API_KEY=your_groq_api_key_here
ALERT_CHAT_ID=your_telegram_chat_id
TELEGRAM_CHAT_ID=758752313
```

**After** (target — 10 lines, adds the documented gap from 1.5.1):

```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
GROQ_API_KEY=your_groq_api_key_here
ALERT_CHAT_ID=your_telegram_chat_id
TELEGRAM_CHAT_ID=758752313

SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_jwt_here
SUPABASE_ANON_KEY=your_anon_jwt_here
```

**Unified diff:**

```diff
--- a/.env.example
+++ b/.env.example
@@ -1,4 +1,8 @@
 TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
 GROQ_API_KEY=your_groq_api_key_here
 ALERT_CHAT_ID=your_telegram_chat_id
 TELEGRAM_CHAT_ID=758752313
+
+SUPABASE_URL=https://your-project-ref.supabase.co
+SUPABASE_SERVICE_ROLE_KEY=your_service_role_jwt_here
+SUPABASE_ANON_KEY=your_anon_jwt_here
```

**Style verification:**
- אין הערות מובנות בקובץ הקיים → לא מוסיף הערות `#` (שמירת סגנון).
- Placeholders בסגנון הקיים: `your_*_here`.
- שורת ריק בין הסקציות (Telegram/Groq vs. Supabase) להפרדה ויזואלית. אם שילה מעדיף בלי שורת ריק — שינוי טריוויאלי ב-1.5.3.

### 3.3 No other files touched

- 14 קבצי הצרכן → no change (כולם משתמשים ב-`require('./supabase')`).
- Render: שינוי ENV רק (לא קוד שנדחף).
- BMAD docs: רק `docs/security/01c-architect-design.md` (זה).

---

## 4. Startup Log Contract

הפלט המדויק שיופיע ב-stdout של Render:

| Scenario | Exact log line |
|---|---|
| service_role configured | `[Supabase] Connected ✅ — auth role: service_role` |
| only anon configured (FALLBACK) | `[Supabase] Connected ✅ — auth role: anon (FALLBACK — set SUPABASE_SERVICE_ROLE_KEY)` |
| neither configured | `[Supabase] Not configured — using JSON fallback` |

**מה שלא יודפס** (אין דליפה):
- ערך המפתח עצמו.
- prefix של המפתח (אפילו 4 תווים — חוסם מהפרסום אבל לא מסייע ל-debugging).
- ה-URL לא נוגע בלוג (היה כבר מוסתר במקור — לא משנה).

**איך @qa מאמת:**
1. אחרי ה-deploy של 1.5.3, לקרוא את Render service logs.
2. לחפש את המחרוזת המדויקת `auth role: service_role`.
3. אם מופיע `auth role: anon (FALLBACK ...` — ה-deploy עבד אבל ה-env לא הוגדר → STOP, לבדוק Render env.
4. אם לא מופיע אף אחד מהשניים — בעיית startup רחבה יותר → STOP, לבדוק Render logs מלאים.

---

## 5. Risk Analysis

| # | Threat | Likelihood | Impact | Mitigation | Rollback Cost |
|---|---|---|---|---|---|
| R1 | שילה מוסיף `SUPABASE_SERVICE_ROLE_KEY` עם value שגוי (נדבק רווח/שורה חדשה) | Med | Bot crashes על calls ל-DB; כל הצרכנים נכשלים | startup log יראה `service_role` אבל calls יחזרו 401 — קל לזהות בלוגים תוך דקות | Low — מסירים את ה-env, redeploy חוזר ל-anon |
| R2 | שילה שוכח להוסיף את ה-env לפני ה-code deploy | Low (env-first explicit) | אפס — fallback ל-anon פעיל | startup log יציג `FALLBACK` בצורה ברורה | Zero |
| R3 | מפתח service_role דולף דרך Render audit log או שיתוף screen | Med (אנושי) | קטסטרופי — bypass RLS לתמיד | Render אינו מציג ערכים אחרי שמירה (צריך reveal ידני). שילה ייעצר משיתוף screen של env. אחרי 1.5 בו זמן יציב — לסובב את ה-key | Med — סיבוב המפתח דורש update ב-Render + restart |
| R4 | ה-libraries של Supabase מתנהגות שונה תחת service_role (rate limiting, query plan) | Very Low | אפשרי — service_role עוקף PostgREST policy checks אז יותר מהיר | smoke test plan מבחן את כל 12 הטבלאות תוך דקות | Zero — אין שינוי schema |
| R5 | ה-cron jobs (07:00, 16:30, 21:00, 08:30 ראשון) נופלים תחת ה-key החדש | Very Low | scheduled briefings/Shabbat eve message חסרים | proactive scheduler משתמש באותו `supabase` instance — אם הוא עובד למשתמש, גם cron עובד | Zero — אם ה-service_role עובד interactive, יעבוד גם ב-cron |
| R6 | ה-anon var נשאר ב-`.env`/Render אחרי שלב 3 ומישהו ממופה אליו בטעות בעתיד | Med-Long | הפיכת ה-key הציבורי ל"שותף" מותר → דליפה של path | בקובץ `.env.example` אחרי שלב 3, להעיף את `SUPABASE_ANON_KEY` (work item ל-Phase 5) | Low |
| R7 | שינוי הלוג ימוטט parser/grep automation שלך | Very Low | dashboards/alerts פוטנציאלית כבים | אין לי אינדיקציה לקיום parser כזה (לא מצאתי ב-1.5.1). לבדוק ב-@qa | Zero — להחזיר את הלוג לשורה המקורית בקלות |
| R8 | הבוט מאחסן את `supabase` ב-singleton בעת load → אם ה-env מתחלף בזמן ריצה, השינוי לא נקלט עד restart | Low | restart נדרש כדי להחיל env חדש — אבל זה כך גם היום | בכוונה — Render עושה auto-restart בכל env change. תיעוד ב-test plan | Zero — auto-restart |

**Hot path implications (per analyst findings § 3.13):**
- `bot/agent-memory.js` (memory) — נקרא על כל הודעה. הסתברות גבוהה ביותר לראות regression מהיר. **חיובי לזיהוי מהיר.**
- `bot/metrics-history.js` — 5 טבלאות. רגרסיה בו תעיד על בעיה רוחבית, לא ספציפית לטבלה.
- `bot/auth.js` — Google OAuth flow. אם נשבר, שילה לא יוכל לחבר חשבון Google חדש (אבל auth_tokens קיימים עדיין יעבדו).
- `bot/backup.js` — fail silently. נדרשת בדיקה אקטיבית ב-@qa, לא להסתמך על "absence of error".

---

## 6. Render Env Var Change Plan (env-first)

### 6.1 מצב נוכחי ב-Render (assumed)

| Var | Value source | Required? |
|---|---|---|
| `SUPABASE_URL` | קיים | Yes |
| `SUPABASE_ANON_KEY` | קיים | Yes (today) |
| `SUPABASE_SERVICE_ROLE_KEY` | חסר | No (today) |

### 6.2 שינויים ב-Render

| Step | Action | When | Who |
|---|---|---|---|
| 1 | Add `SUPABASE_SERVICE_ROLE_KEY` with the value from Supabase dashboard | **Before code deploy** | שילה |
| 2 | Save → triggers auto-redeploy of Render service | Auto | Render |
| 3 | Verify Render logs show `[Supabase] Connected ✅` (still anon, since old code ignores the new var) | Within ~1 min | שילה |
| 4 | @dev pushes the code change to `security/enable-rls-lockdown` (after Phase 1.5.2 approval) | After approval | @dev |
| 5 | שילה merges to main / triggers Render deploy of the new branch | Manual | שילה |
| 6 | Render redeploy starts | Auto | Render |
| 7 | Verify Render logs now show `[Supabase] Connected ✅ — auth role: service_role` | Within ~1 min | @qa |
| 8 | Run smoke tests § 7 | Within ~10 min | @qa + שילה |
| 9 | KEEP `SUPABASE_ANON_KEY` set on Render through all of Phase 3 (RLS migration) | Through 2026-05-XX | שילה |
| 10 | After Phase 5 (24h soak post-RLS), optionally remove `SUPABASE_ANON_KEY` from Render | Phase 5 task | שילה |

### 6.3 Justification — env-first vs. code-first

**Env-first (chosen):**
- ה-env החדש מתווסף ל-Render לפני הקוד. הקוד הישן (anon-only) פשוט מתעלם ממנו → no behavior change.
- כש-code-deploy מגיע, ה-env כבר קיים → הקוד מתחיל מיד עם service_role.
- **Rollback:** revert של commit הקוד = הבוט חוזר לקרוא רק `SUPABASE_ANON_KEY` ⇒ עובד בדיוק כמו לפני העבודה הזאת. אפס downtime.

**Code-first (rejected):**
- הקוד נדחף עם fallback. ה-env עדיין לא קיים. ⇒ הקוד מתחיל ב-anon (FALLBACK log).
- שילה מוסיף את ה-env. ⇒ Render redeploy מרים ב-service_role.
- **Rollback:** revert הקוד אחרי שה-env כבר נוסף = הבוט חוזר ל-`SUPABASE_ANON_KEY` (עובד), אבל ה-env החדש נשאר תלוי על Render בלי להיקרא ע"י הקוד.
- חסרון: 2 redeploys במקום 1 משמעותי (env-first → 1 redeploy אוטומטי + 1 deploy manual; code-first → 1 deploy + 1 redeploy אחרי env). בפועל אותו דבר.
- חסרון רציני יותר: בחלון בין ה-deploy של הקוד לבין הוספת ה-env, הלוג מציג `FALLBACK` — קל לטעות ולחשוב שמשהו נשבר.

**הכרעה: env-first.** קל יותר לאמת ויש מצב ביניים נקי יותר (הקוד הישן מתעלם מ-env שלא רלוונטי לו, במקום הקוד החדש שצועק FALLBACK כי env לא הוגדר עוד).

---

## 7. QA Test Plan

### 7.1 Pre-deploy (local, by @dev before push)

| Step | Command | Pass Criterion |
|---|---|---|
| Syntax check | `node -c bot/supabase.js` | exit 0 |
| Quick require test | `SUPABASE_URL=x SUPABASE_SERVICE_ROLE_KEY=y node -e "console.log(require('./bot/supabase').isEnabled())"` | prints `true`; log shows `auth role: service_role` |
| Anon fallback test | `SUPABASE_URL=x SUPABASE_ANON_KEY=y node -e "console.log(require('./bot/supabase').isEnabled())"` | prints `true`; log shows `auth role: anon (FALLBACK — ...)` |
| Unconfigured test | `node -e "console.log(require('./bot/supabase').isEnabled())"` | prints `false`; log shows `Not configured — using JSON fallback` |
| Lint pass | (no eslint configured per 1.5.1 — confirm `package.json` has no `lint` script) | n/a, document the absence |
| Git surgical staging | `git diff --stat` after `git add bot/supabase.js .env.example docs/security/` | exactly 2 source files + the 4 docs/security/ files |
| Pre-existing dirty state untouched | `git status` | M `bot/image-editor.js`, M `data/*.json`, ?? `data/*.json` still present and untouched |

### 7.2 Post-deploy verification (Render logs)

| Order | Check | Pass Criterion |
|---|---|---|
| 1 | Render deploy succeeded (build log green) | exit code 0 |
| 2 | Service started (process listening) | `Listening on port ...` (or whatever index.js logs) |
| 3 | Supabase connected | `[Supabase] Connected ✅ — auth role: service_role` |
| 4 | No 401/403 from Supabase in first 30s | no occurrences of `401`, `Unauthorized`, `JWT` errors |
| 5 | Cron scheduler started | proactive scheduler boot log present (per CLAUDE.md, `bot/proactive.js` initializes on startup) |

### 7.3 Smoke tests — Telegram messages (@qa drives, שילה sends)

לכל טבלה: הודעה אחת שמפעילה reads או writes לטבלה הזאת. שילה שולח, @qa צופה ב-Render logs.

| Test ID | Table | Telegram message | Expected behavior | Render log signature |
|---|---|---|---|---|
| T01 | `memory` | "מה אתה זוכר עליי?" | הבוט עונה עם זיכרונות שמורים | `[agent]` rounds; no Supabase 401 |
| T02 | `tasks` | "תוסיף משימה: לבדוק רופא" | הבוט מאשר הוספה | tool: `add_task` → row inserted |
| T03 | `tasks` (read) | "מה המשימות שלי?" | הבוט מחזיר רשימה | tool: `get_tasks` → rows returned |
| T04 | `watchlist` | "מה במניות שלי?" | הבוט מחזיר רשימה | tool: `get_watchlist` (skill) — read OK |
| T05 | `health_logs` | "תרשום: כאב 6, עייפות 4" | הבוט מאשר רישום | tool: `log_health` → upsert OK |
| T06 | `health_logs` (read) | "מה הסטטוס שלי היום?" | הבוט מחזיר היומן | tool: `get_health_today` |
| T07 | `habits` | "תוסיף הרגל: שתיית מים" | הבוט מאשר | habits skill — upsert |
| T08 | `expenses` | "תוסיף הוצאה: 50 שקל קפה" | הבוט מאשר | expenses skill — insert |
| T09 | `leads` | (skill-level — שילה לבחור הודעה רלוונטית מ-bot/leads.js workflow) | הבוט מאשר/מחזיר | reads/writes לפי ה-flow |
| T10 | `passwords` | "תשמור סיסמה: gmail / shilo@example.com / abc123" | הבוט מאשר ומצפין | password-manager — upsert |
| T11 | `auth_tokens` | (אינטראקטיבי — אין tool ישיר; ניתן לחכות שטוקן Gmail/Calendar יתחדש בזמן `get_unread_emails`) | OAuth flow עובד | `bot/auth.js:45` lookup, אם קיים — refresh זורם |
| T12 | `backups` | "/backup" (אם יש slash command — אחרת מחכים ל-cron האוטומטי) | הבוט מאשר backup | `bot/backup.js:94` insert |
| T13 | `doc_summaries` | (לשלוח PDF/DOC לבוט) | הבוט מסכם | doc-summary skill — insert |
| T14 | `image_edits` | (לשלוח תמונה + הוראה "תחתוך עיגול") | הבוט עורך | image-editor skill — insert |

**Pass criterion:** כל T01–T14 חוזרים עם reply תקין מהבוט, ואף אחד מ-Render logs לא מציג שגיאת `401`, `Unauthorized`, `JWT`, או `permission denied`.

### 7.4 Hot-path observation (passive)

לאחר שכל הטסטים פעילים, להשאיר את Render logs פתוחים ל-30 דקות נוספות, ולחפש:
- כל occurrence של `[Supabase]` חוץ משורת ה-startup → סימן לשגיאה.
- `503`, `502`, `ECONNREFUSED` → תקלת רשת בלתי קשורה.
- חזרה של `auth role: anon (FALLBACK ...)` ב-restart → ה-env נמחק/חזר. STOP.

### 7.5 Snapshot verification

לאחר 30 דקות יציבות, לרוץ את ה-COUNT(*) שוב על 12 הטבלאות (לפי `pre-fix-snapshot-2026-04-30.md`). כל טבלה: post >= pre.

חריג מותר: `backups` יכולה לרדת אם ה-pruning rolled (per snapshot doc note). כל טבלה אחרת — חייב >=.

---

## 8. Rollback Plan

יש שני מסלולי רולבק, לפי איפה הבעיה התגלתה.

### 8.1 Rollback A — code-only revert (env שלם, קוד גרם תקלה)

**Trigger:** Render logs מציגים `auth role: service_role` אבל יש שגיאות 401/permission על calls ל-DB; או הבוט נופל ב-startup אחרי deploy.

**Steps:**
1. שילה ב-Render UI: "Rollback to previous deploy" (one-click).
2. Render משחזר את ה-image הקודם (קוד pre-1.5.3).
3. הקוד הישן מתעלם מ-`SUPABASE_SERVICE_ROLE_KEY` ועובד עם `SUPABASE_ANON_KEY`.
4. שילה מאמת startup log: `[Supabase] Connected ✅` (הפורמט הישן).
5. שלא לשנות env — להשאיר את `SUPABASE_SERVICE_ROLE_KEY` במקום (מעלות מאוחר יותר).
6. @dev/Winston פותחים פוסט-מורטם: למה ה-deploy נפל? להחזיר לאחור ב-git: `git revert <SHA>` על ה-branch.

**Downtime:** ~30s עד דקה (זמן Render redeploy).

### 8.2 Rollback B — env-only fix (קוד תקין, env שגוי)

**Trigger:** Render logs מציגים `auth role: service_role` אבל ה-key פג/שגוי, וה-DB מחזיר 401 על כל בקשה.

**Steps:**
1. שילה ב-Render env: למחוק את `SUPABASE_SERVICE_ROLE_KEY`.
2. Render auto-redeploy.
3. הקוד החדש לא מוצא `SUPABASE_SERVICE_ROLE_KEY` → fallback ל-`SUPABASE_ANON_KEY`.
4. אימות startup log: `[Supabase] Connected ✅ — auth role: anon (FALLBACK — set SUPABASE_SERVICE_ROLE_KEY)`.
5. הבוט עובד שוב על anon (זהה למצב לפני העבודה).
6. שילה לוקח את ה-key הנכון מ-Supabase dashboard ומחליף ב-Render. Redeploy. אימות.

**Downtime:** ~30s עד דקה.

### 8.3 Rollback C — total revert (במקרה החמור ביותר)

**Trigger:** שניים מהמסלולים נכשלו, או יש חשד שאין דרך לחזור באופן בטוח.

**Steps:**
1. שילה ב-Render: rollback to previous deploy.
2. שילה ב-Render env: למחוק את `SUPABASE_SERVICE_ROLE_KEY`.
3. Redeploy.
4. אימות startup log: `[Supabase] Connected ✅` (הפורמט הישן, anon-only).
5. אם ה-key החדש (service_role) עוד "live" — לסובב אותו דרך Supabase dashboard לצמיתות, כי הסיכון שהוא דלף לפי סיבה לא ידועה הוא ממשי.

**Downtime:** ~1–2 דקות (שתי redeploys).

### 8.4 Trigger conditions (when to rollback)

| Severity | Symptom | Rollback type |
|---|---|---|
| Critical | startup log לא מציג `[Supabase] Connected` תוך 60s אחרי deploy | A (code revert) |
| Critical | 401/403 mass spike מ-DB calls תוך 5 דקות אחרי deploy | A or B (חקירת env first; אם clean → A) |
| High | טסט T01 (memory) נכשל = הבוט לא עונה | A |
| High | smoke test כלשהו T02–T14 נכשל פעמיים ברצף | חקירה ב-Render logs; אם RLS-related → A |
| Med | warning log רעש לא קשור (e.g. cron skipped once) | אין rollback — לתעד ולהמשיך |
| Low | startup log מציג FALLBACK | B (env fix) |

---

## Handoff Note ל-`@dev` (Sub-Phase 1.5.3)

המסמך הזה כולל את **כל** מה שצריך כדי לבצע את 1.5.3:

1. **המקום היחיד שצריך לערוך קוד:** `bot/supabase.js` — רואה § 3.1 לפני/אחרי + diff.
2. **המקום היחיד שצריך לערוך env doc:** `.env.example` — רואה § 3.2.
3. **לא לערוך כלום אחר.** 14 הצרכנים, ה-skills, ה-cron — אפס שינויים.
4. **לא לעשות `git add .` או `git add -A`.** רק add ספציפי לפי § 7.1 (שורה אחרונה).
5. **commit message** הוצע ע"י המשתמש בהוראות 1.5.3 — להשתמש בו verbatim.

@dev ייעצר אחרי שיציג את ה-`git diff` ויחכה לאישור לפני commit + push.

— Winston 🏗️
