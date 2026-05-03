# Sub-Phase 1.5.1 — Analyst Findings: Supabase Auth Surface Audit

> **Note:** This document supersedes the never-produced `01-investigation.md`. Phase 1 investigation findings are consolidated here.

| Field | Value |
|---|---|
| Author | Mary — BMAD Business Analyst (📊) |
| Date | 2026-04-30 |
| Mode | READ-ONLY investigation |
| Scope | Sub-Phase 1.5.1 of `security/enable-rls-lockdown` work |
| Project | lifepilot-bot (`shilobilo`) |
| Predecessor | Phase 1 (in `01-investigation.md` — to be backfilled) |
| Successor (gated) | Sub-Phase 1.5.2 — `@architect` design |

---

## TL;DR — תקציר מנהלים

- **משטח שינוי קטן באופן יוצא דופן.** רק קובץ אחד מאתחל את Supabase: `bot/supabase.js`. כל 14 הצרכנים מתחת ל-`bot/` יורשים את ה-client דרך module export. **המעבר מ-anon ל-service_role הוא שינוי של שורה אחת בקוד** + עדכון env ב-Render + תיעוד ב-`.env.example`.
- **אין דליפה היסטורית של מפתחות.** סריקה של כל ה-blobs בכל ה-refs לא מצאה את ה-anon JWT, את הקידומת `eyJ...`, או את המחרוזת `service_role` באף commit. `.env` מעולם לא נכנס ל-git.
- **המפתח הנוכחי הוא `anon` JWT (רישוי ציבורי).** מאומת מ-payload (`role=anon`, `iss=supabase`, `ref=zxxcdvveezcjuwijwlab`). הוא זהה לחלוטין למחרוזת ש-Supabase מפרסם פומבית בדאשבורד. ה"סוד" שמפעיל את הבוט הוא לא סוד — הוא מחרוזת מוסכמת.
- **אין צרכן Supabase מחוץ ל-Render.** אין קוד browser/frontend, אין SDK שני, אין wrapper נוסף.
- **שאלות פתוחות שדורשות הכרעה לפני שלב 1.5.2.** רוכזו בסעיף 5.

---

## 1. Initialization Audit

יש בדיוק **init site אחד** בכל הריפו:

| File | Line | Statement (semantic) | Env vars referenced | Role at runtime |
|---|---|---|---|---|
| `bot/supabase.js` | 3 | `require('@supabase/supabase-js')` | — | — |
| `bot/supabase.js` | 5 | `SUPABASE_URL = process.env.SUPABASE_URL` | `SUPABASE_URL` | — |
| `bot/supabase.js` | 6 | `SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY` | `SUPABASE_ANON_KEY` | **anon** (verified) |
| `bot/supabase.js` | 9 | guard `if (SUPABASE_URL && SUPABASE_ANON_KEY)` | both | — |
| `bot/supabase.js` | 10 | `createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })` | both | **anon** |
| `bot/supabase.js` | 13 | `console.log('[Supabase] Connected ✅')` (no role logged) | — | — |
| `bot/supabase.js` | 15 | `console.log('[Supabase] Not configured — using JSON fallback')` | — | — |

**Verification of role.** ה-key ב-`.env` הוא JWT. ה-payload (חלק שני, base64) פורמט בלי הצגת ה-secret והכיל: `role=anon`, `iss=supabase`, `ref=zxxcdvveezcjuwijwlab`. זה משכפל את אותו string בדיוק שהמשתמש סיפק כ-public anon ב-Phase 3.6.

**No other createClient sites.** סריקה רגקס של `createClient` ושל `@supabase/supabase-js` בכל קבצי ה-`.js` (מחוץ ל-`node_modules`) החזירה רק את `bot/supabase.js`. אין אתחול נוסף.

**Logging gap (relevant for 1.5.2).** ה-startup log לא חושף את ה-role. ה-architect יצטרך להוסיף שורת log שמדפיסה את ה-role (לא את המפתח) כדי שאפשר יהיה לאמת על Render אחרי המעבר.

---

## 2. Reference Audit — Env Var Literals

סריקה ב-`.js`, `.md`, `.example`, `.json` (מחוץ ל-`package-lock.json`), `.sh`:

| Literal | Occurrences | Files |
|---|---|---|
| `SUPABASE_ANON_KEY` | 3 | `bot/supabase.js:6, :9, :10` |
| `SUPABASE_KEY` | 0 | — |
| `SUPABASE_SERVICE_ROLE_KEY` | 0 | — |
| `SUPABASE_PUBLISHABLE_KEY` | 0 | — |
| `SUPABASE_SECRET` | 0 | — |
| `SUPABASE_URL` | 2+ | `bot/supabase.js:5, :9` |

**`.env` (live, on disk):** מכיל `SUPABASE_URL=...` ו-`SUPABASE_ANON_KEY=...`. ערכים לא צוטטו במסמך זה.

**`.env.example` (committed):**
```
TELEGRAM_BOT_TOKEN=...
GROQ_API_KEY=...
ALERT_CHAT_ID=...
TELEGRAM_CHAT_ID=...
```
**אין שורת `SUPABASE_*` כלל.** כלומר, האונבורדינג של מפתח חדש (או Render restore) לא יודע שצריך משתני Supabase. זוהי **פער תיעודי** שצריך לסגור ב-1.5.3.

---

## 3. Call-Site Map (12 RLS-affected Tables)

לכל טבלה: כל `supabase.from('<table>')` — קריאות וכתיבות. המספרים הם `file:line` של תחילת ה-call.

### 3.1 `leads` — 8 call-sites

| File:Line | Operation |
|---|---|
| `bot/leads.js:56` | `.from('leads')` (chain — read) |
| `bot/leads.js:78` | `.from('leads').insert(...)` |
| `bot/leads.js:104` | `.from('leads').select('*').eq('id', id).maybeSingle()` |
| `bot/leads.js:108` | `.from('leads')` (chain) |
| `bot/leads.js:135` | `.from('leads').select('*').eq('id', id).maybeSingle()` |
| `bot/leads.js:139` | `.from('leads')` (chain) |
| `bot/leads.js:195` | `.from('leads')` (chain) |
| `bot/metrics-history.js:151` | `.from('leads').select('created_at').gte(...)` |

### 3.2 `health_logs` — 3

| File:Line | Operation |
|---|---|
| `bot/health.js:42` | `.from('health_logs')` (chain) |
| `bot/health.js:55` | `.from('health_logs').upsert(...)` |
| `bot/metrics-history.js:173` | `.from('health_logs').select('data, created_at')` |

### 3.3 `habits` — 5

| File:Line | Operation |
|---|---|
| `bot/habits.js:40` | `.from('habits')` (chain) |
| `bot/habits.js:53` | `.from('habits').upsert(...)` |
| `bot/habits.js:79` | `.from('habits').delete().eq('id', String(id))` |
| `bot/habits.js:98` | `.from('habits').select('id')` |
| `bot/metrics-history.js:88` | `.from('habits').select('data')` |

### 3.4 `expenses` — 4

| File:Line | Operation |
|---|---|
| `bot/expenses.js:45` | `.from('expenses')` (chain) |
| `bot/expenses.js:62` | `.from('expenses').select('id')` |
| `bot/expenses.js:88` | `.from('expenses').insert(...)` |
| `bot/metrics-history.js:116` | `.from('expenses').select('data, created_at')` |

### 3.5 `tasks` — 5

| File:Line | Operation |
|---|---|
| `bot/tasks.js:40` | `.from('tasks')` (chain) |
| `bot/tasks.js:53` | `.from('tasks').upsert(...)` |
| `bot/tasks.js:80` | `.from('tasks').delete().eq('id', String(id))` |
| `bot/tasks.js:100` | `.from('tasks').select('id')` |
| `bot/metrics-history.js:65` | `.from('tasks').select('data, created_at')` |

### 3.6 `passwords` — 3

| File:Line | Operation |
|---|---|
| `bot/password-manager.js:73` | `.from('passwords').select('*')` |
| `bot/password-manager.js:93` | `.from('passwords').upsert(...)` |
| `bot/password-manager.js:138` | `.from('passwords').delete().eq('id', key)` |

### 3.7 `memory` — 2 (hot path — agent context)

| File:Line | Operation |
|---|---|
| `bot/agent-memory.js:52` | `.from('memory')` (chain — read) |
| `bot/agent-memory.js:69` | `.from('memory').upsert(...)` |

### 3.8 `watchlist` — 4

| File:Line | Operation |
|---|---|
| `bot/stocks.js:103` | `.from('watchlist')` (chain) |
| `bot/stocks.js:115` | `.from('watchlist').upsert(...)` |
| `bot/stocks.js:146` | `.from('watchlist').delete().eq('id', String(r.id))` |
| `bot/stocks.js:156` | `.from('watchlist').select('id')` |

### 3.9 `auth_tokens` — 5 (sensitive — `token` column flagged in advisor)

| File:Line | Operation |
|---|---|
| `bot/auth.js:25` | `.from('auth_tokens').insert(...)` |
| `bot/auth.js:45` | `.from('auth_tokens')` (chain) |
| `bot/auth.js:59` | `.from('auth_tokens').update(updates).eq('token', token)` |
| `bot/auth.js:66` | `.from('auth_tokens').delete().eq('token', token)` |
| `bot/auth.js:73` | `.from('auth_tokens')` (chain) |

### 3.10 `backups` — 8

| File:Line | Operation |
|---|---|
| `bot/backup.js:27` | `.from('backups')` (chain) |
| `bot/backup.js:94` | `.from('backups').insert(...)` |
| `bot/backup.js:122` | `.from('backups')` (chain) |
| `bot/backup.js:136` | `.from('backups')` (chain) |
| `bot/backup.js:153` | `.from('backups').select('id')` |
| `bot/backup.js:158` | `.from('backups').delete().in('id', toDelete)` |
| `bot/backup.js:164` | `.from('backups').select('id')` |
| `bot/backup.js:169` | `.from('backups').delete().in('id', toDelete)` |

### 3.11 `doc_summaries` — 3

| File:Line | Operation |
|---|---|
| `bot/doc-summary.js:119` | `.from('doc_summaries').insert(...)` |
| `bot/doc-summary.js:142` | `.from('doc_summaries')` (chain) |
| `bot/doc-summary.js:157` | `.from('doc_summaries')` (chain) |

### 3.12 `image_edits` — 4

| File:Line | Operation |
|---|---|
| `bot/image-editor.js:149` | `.from('image_edits').insert(...)` |
| `bot/image-editor.js:169` | `.from('image_edits')` (chain) |
| `bot/image-editor.js:184` | `.from('image_edits')` (chain) |
| `bot/image-editor.js:201` | `.from('image_edits')` (chain) |

### 3.13 Cross-cutting consumer

`bot/metrics-history.js` — קורא **5 טבלאות** (`leads`, `health_logs`, `habits`, `expenses`, `tasks`). זהו הצרכן הרחב ביותר של API ה-DB. כל רגרסיה ב-RLS תיראה ראשית ב-flow של `metrics-history`.

### 3.14 Module import map (consumers of `bot/supabase.js`)

| File:Line | Import shape |
|---|---|
| `bot/agent-memory.js:5` | `const { supabase, isEnabled } = require('./supabase');` |
| `bot/health.js:5` | same |
| `bot/metrics-history.js:3` | same |
| `bot/stocks.js:6` | same |
| `bot/index.js:24` | `const { supabase: supaClient, isEnabled: supaEnabled } = require('./supabase');` |
| `bot/index.js:320` | `const { isEnabled: supabaseEnabled } = require('./supabase');` (dynamic — `isEnabled` only) |
| `bot/backup.js:3` | `const { supabase, isEnabled } = require('./supabase');` |
| `bot/doc-summary.js:6` | same |
| `bot/expenses.js:6` | same |
| `bot/auth.js:4` | same |
| `bot/habits.js:5` | same |
| `bot/tasks.js:5` | same |
| `bot/image-editor.js:14` | same |
| `bot/password-manager.js:13` | same |
| `bot/leads.js:5` | same |

**14 consumer files**, כולם עוברים דרך `./supabase`. זה אומר: שינוי בלעדי בקובץ האתחול → כל הצרכנים מקבלים את ה-client החדש בלי שינוי קוד.

---

## 4. Surface Area Summary — How Many Files Need to Change?

| Bucket | Files | Notes |
|---|---|---|
| Code change required | **1** — `bot/supabase.js` | קריאת `SUPABASE_SERVICE_ROLE_KEY` עם fallback ל-`SUPABASE_ANON_KEY`; הוספת startup log שמציג את ה-role |
| Doc change required | **1** — `.env.example` | להוסיף שורות `SUPABASE_URL=` ו-`SUPABASE_SERVICE_ROLE_KEY=`; אופציונלי גם `SUPABASE_ANON_KEY=` כ-fallback |
| Render env (out-of-repo) | n/a | להוסיף `SUPABASE_SERVICE_ROLE_KEY`; להשאיר `SUPABASE_ANON_KEY` זמנית כ-safety net |
| Bot consumer files | **0** | כולם משתמשים ב-`require('./supabase')` — בלי שינוי |

ציפיית ה-brief הייתה 1–3. **המספר בפועל: 2 קבצים בריפו + הגדרת env ב-Render.** עומד בציפייה.

---

## 5. Open Questions for the User (gating before 1.5.2)

לפני שאני מעבירה ל-`@architect`, צריך החלטות שלך:

### Q1 — יצירת branch
ההוראות שלך אומרות "stay on `security/enable-rls-lockdown`". בפועל, אנחנו על `main` ו-branch כזה לא קיים (רק `main` מקומי + `remotes/origin/main`). האם:
- **(a)** ליצור עכשיו `security/enable-rls-lockdown` מ-`main` ולהמשיך? **(מומלץ — Phase 1 לא דרש branch, אבל 1.5.3 ידרוש commit)**
- **(b)** לבצע 1.5.1 ו-1.5.2 (read-only/docs בלבד) על `main` ולפצל branch רק לפני 1.5.3 (implementation)?

### Q2 — Working tree dirty
יש שינויים לא קשורים בתיקייה הנוכחית:
- modified: `bot/image-editor.js`, `data/expenses.json`, `data/health-log.json`, `data/tasks.json`
- untracked: `data/habits.json`, `data/passwords.json`, `data/stock-watchlist.json`

זה לא קשור לעבודת האבטחה, אבל זה משפיע על איך שה-commit ב-1.5.3 ייראה. האם:
- **(a)** stash את השינויים הקיימים, לבצע את עבודת האבטחה נקייה, אז להחזיר?
- **(b)** לוודא שה-`git add` ב-1.5.3 מוסיף רק את `bot/supabase.js` ו-`.env.example` (וקבצי `docs/security/*`) ולהשאיר את שאר השינויים בעתיד?
- **(c)** קודם לסדר את השינויים הקיימים בנפרד, ואז לחזור ל-security work?

### Q3 — מפתח service_role: מקור וזמן
- מי מביא את ה-key? אתה תכנס ל-Supabase dashboard → Settings → API Keys → Legacy → service_role → Reveal, ותעביר ל-Render?
- האם יש העדפה לשמור עותק ב-`.env` המקומי לבדיקות, או רק על Render? **(המלצה: גם ב-`.env` המקומי לטסטים בעתיד, אבל לעולם לא לעדכן `.env.example`/git.)**

### Q4 — סדר deploy ב-Render: env לפני קוד או הפוך?
זה נושא ל-`@architect`, אבל אני סוקרת אותו פה כי הוא תלוי ב-Q3. שתי גישות:
- **(a) env-first:** להוסיף `SUPABASE_SERVICE_ROLE_KEY` ל-Render *לפני* deploy של הקוד החדש. הקוד הישן מתעלם מהמשתנה. ה-deploy של הקוד פשוט מפעיל את הקריאה. ⇒ **רולבק קל** — מספיק לבטל deploy.
- **(b) code-first:** לעלות את הקוד עם ה-fallback, אז להוסיף את ה-env, אז restart. ⇒ דורש restart נוסף, יותר surface ל-flake.

אני מעדיפה **env-first**, אבל זה החלטת `@architect`. רק רוצה לוודא שאתה מודע לטרייד-אוף.

### Q5 — Phase 1's `01-investigation.md`
ה-brief המקורי של Phase 1 (הודעה 1488–1497) ביקש להפיק `docs/security/01-investigation.md` עם 7 חלקים, ו-Phase 1 נעצרה בנקודה 1.4 כאשר התגלה ה-anon key. כמה מהחלקים (1.6 snapshot של row counts, 1.7 הדו"ח עצמו) **לא הופקו**. האם:
- **(a)** להפיק את `01-investigation.md` עכשיו במקביל ל-`01b-analyst-findings.md`, כדי שיהיה תיעוד מלא של Phase 1 בנפרד?
- **(b)** להעתיק תוכן רלוונטי מ-`01b` ל-`01-investigation.md` בסוף, או לחבר את שניהם למסמך אחד?
- **(c)** להחליט ש-`01b` *הוא* התחליף ל-`01-investigation.md` (כי הוא מקיף יותר), ולסכם זאת ב-handoff ל-Phase 2?

### Q6 — Snapshot של row counts (Phase 1.6)
לא הרצנו את ה-SQL הזה. אין כלי Supabase MCP זמין כרגע ב-session. שלוש דרכים:
- **(a)** אתה מריץ ב-Supabase SQL Editor ומדביק את התוצאה.
- **(b)** סקריפט Node קצר שמשתמש ב-client הקיים (anon מספיק כל עוד RLS עוד OFF).
- **(c)** דחיית ה-snapshot ל-3.2 (לפני ה-migration), כי הוא קריטי שם, לא פה. **(מומלץ — מינימום שינויים עכשיו.)**

---

## Appendix A — Git History Leak Audit (clean)

נסרקו **כל ה-blobs** הניתנים-להגעה מכל ה-refs (`git rev-list --all --objects` → `git cat-file -p` per blob → grep). תוצאה:

| Pattern | Found in any committed blob? |
|---|---|
| `.env` (file path) | ❌ Never tracked |
| `service_role` (literal) | ❌ Never present |
| `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9` (JWT prefix) | ❌ Never present |
| `ltiPzxiDzCWgCMlANZkz` (anon JWT signature segment) | ❌ Never present |

`.gitignore` מכיל `.env` + `google_credentials.json` + `google_token.json`. ההיגיינה תקינה.

**מסקנה לאיומים:** אין צורך ברוטציית מפתח לפני המעבר על בסיס דליפת היסטוריה. רוטציית ה-anon key לאחר ההפעלה של RLS נשארת כחלק מההיגיינה (אבל לא דחוף — anon key ציבורי ממילא).

---

## Appendix B — Branch & Working Tree State

```
* main
  remotes/origin/main
```

Working tree (pre-existing, לא קשור לעבודת האבטחה):
```
M  bot/image-editor.js
M  data/expenses.json
M  data/health-log.json
M  data/tasks.json
?? data/habits.json
?? data/passwords.json
?? data/stock-watchlist.json
```

ראה Q1 ו-Q2 לעיל.

---

## Appendix C — Threat Model (current state, before any change)

מי יכול לגשת למה כעת?

| Actor | Access | Impact |
|---|---|---|
| הבוט (Render) עם anon key | קריאה/כתיבה/מחיקה לכל הטבלאות | משרת — תפקוד תקין |
| **כל מי שיש לו את project URL + anon key** | **אותו דבר בדיוק** | **חמור — anon key ציבורי, RLS OFF** |
| `service_role` user (אם המפתח דלף) | bypass RLS לתמיד | קטסטרופי — אין מפתח כזה בשימוש כעת |
| Supabase Auth users (`authenticated` role) | אותו דבר כמו anon (אין policies) | זהה |

**הפער הקריטי הנוכחי:** `anon` ו-`authenticated` הם בפועל "כל אחד באינטרנט". 12 הטבלאות פתוחות לחלוטין דרך REST. הסיכון לא בא מדליפת מפתח (כי המפתח ציבורי) — **הוא מובנה בקונפיגורציה הנוכחית.**

זה מצדיק את כל מה שמתוכנן: service_role בצד שרת + RLS ENABLE + FORCE על הכל.

---

## Handoff Note

מסמך זה לא מבצע שום שינוי. כל מה שלמעלה הוא תצפית. ההחלטה אם לעבור ל-`@architect` (Sub-Phase 1.5.2) תלויה בתשובות ל-Q1–Q6.

— Mary 📊
