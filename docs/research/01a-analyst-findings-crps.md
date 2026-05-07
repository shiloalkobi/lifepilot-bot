# CRPS Research Agent — Analyst Findings

| Field | Value |
|---|---|
| Author | Mary — BMAD Business Analyst (📊) |
| Date | 2026-05-03 |
| Mode | READ-ONLY research (no code, no schema changes, no integration) |
| Phase | 1 of 6 (analyst → architect → PM → dev → QA → docs) |
| Predecessor | None (Phase 1 entry point) |
| Successor (gated) | Phase 2 — Winston (architect) |
| Branch | `research/crps-agent-phase1` (created from `main`, this doc is the only diff) |
| Hard constraint compliance | Verified §8 — no existing skill/table/scheduler/env/file is changed |

---

## TL;DR — תקציר מנהלים

- **נוף המקורות מתחלק לשתי שכבות איכות הפוכות.** למחקר אקדמי וקליני יש APIs חינמיים מצוינים בלי auth (`PubMed E-utilities`, `ClinicalTrials.gov v2`, `medRxiv API`) שמכסים CRPS לעומק. למקורות ישראליים הספציפיים (משרד הבריאות, קופות חולים, איגודים מקצועיים בעברית) **כמעט אין APIs ציבוריים** — הם דורשים scraping או הסתפקות במקורות בינ"ל. זה הפער המבני המרכזי שמכתיב את החלטות התכנון של Winston בשלב 2.
- **Hope filter הוא לב המוצר, לא תוסף.** אני מציעה rubric בן 3 דרגות עם מסווג Gemini 2.5 Flash inline בקריאת `/research` — עלות אמיתית של ~600 טוקנים למאמר (~$0.00006 ב-Flash), בתחום ה-free tier הקיים של הבוט. דרגת Block מקבלת לוג שקוף ב-`research_blocked_log` כדי שתוכל לבחון מה סיננו ולכוון את ה-rubric.
- **התכונה אדיטיבית 100% (אומת מול הקוד).** סורק ה-skills `bot/skills-loader.js` סורק אוטומטית את `skills/`, אז skill חדש דורש רק drop של תיקייה. CORE tier (`bot/agent.js:386`) לא משתנה — כל הכלים החדשים נכנסים ל-EXTENDED. 12 הטבלאות הקיימות, 4 ה-skills הקיימים (news/vision/voice/web-search), וכל ~12 משימות ה-cron — כולם נשארים כמות-שהם. `bot/supabase.js` לא נוגע. 9 השאלות הפתוחות לסעיף 9 הן מה ש-Winston צריך לסגור איתך לפני התכנון.

---

## 1. Source Landscape — נוף המקורות

המבנה לכל מקור:

> **Type** · **Access** · **Reliability (1–10)** · **CRPS coverage** · **Hebrew/English** · **Free/Paid** · **Update freq** · **Verification**

`Verification` מסווג את המקור:
- ✅ **repo-verified** — אומת מתוך הריפו עצמו (קוד/קבצים/git)
- 🔵 **knowledge-verified** — מבוסס ידע אמין על מבנה ה-API/הארגון, ידוע ויציב לאורך שנים
- 🟡 **needs online verification** — Winston יאמת לפני בנייה (URL, קצב עדכון, או זמינות)
- 🔴 **likely unavailable** — אין סיבה להניח קיום API ציבורי; יידרש scraping או דחייה

### 1.1 אקדמי וקליני

#### PubMed (E-utilities)
- **Type:** מאגר מאמרים peer-reviewed (NLM, NIH)
- **Access:** REST/HTTP, JSON או XML, ללא auth
- **Reliability:** **10/10** — gold standard ביו-רפואי
- **CRPS coverage:** רחב מאוד. חיפוש `"Complex Regional Pain Syndromes"[MeSH]` מחזיר אלפי תוצאות; ~150–250 מאמרים חדשים בשנה (אומדן גס מבוסס עשור אחרון; אומת ב-Phase 2 ע"י Winston)
- **Hebrew:** ❌ אנגלית בלבד (יש שדה לשפה אבל תוכן עברי = nil מעשית)
- **Free/Paid:** חינמי. עם API key (חינמי) — 10 req/sec, בלי key — 3 req/sec
- **Update freq:** רציף; בסיס המאמרים מתעדכן יומיומית
- **Verification:** 🔵 knowledge-verified (E-utilities יציבים מאז 2003; endpoint `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`)
- **המלצה:** המקור הראשי. ה-search strategy בסעיף 2 מבוסס עליו.

#### ClinicalTrials.gov v2 API
- **Type:** רישום ניסויים קליניים (NIH/NLM)
- **Access:** REST/JSON ללא auth; v2 החליף את ה-classic API ב-2024
- **Reliability:** **10/10** — חובה רגולטורית של ניסויים פעילים בארה"ב ובמקרים רבים גם גלובלית
- **CRPS coverage:** סינון לפי `condition=Complex Regional Pain Syndrome` או `CRPS` נותן עשרות ניסויים פעילים בכל זמן נתון; ניתן לסנן לפי `country=Israel` ו-`overallStatus=Recruiting`
- **Hebrew:** ❌ מטא-דאטה באנגלית; **אבל** הפילטר location=Israel חושף ניסויים שמתקיימים בארץ (מרפאות איכילוב, שיבא, רמב"ם, הדסה, סורוקה — כשהם רוקרוטים)
- **Free/Paid:** חינמי, אין rate limit מוצהר, ידידותי לשימוש מתון
- **Update freq:** עדכון ציבורי בתוך ימים מפרסום הניסוי
- **Verification:** 🔵 knowledge-verified (`https://clinicaltrials.gov/api/v2/`)
- **המלצה:** מקור #2 בחשיבות. הוא היחיד שנותן את "ניסוי שמגייס בישראל" — ערך עצום ל-Hope Filter (Tier 1).

#### medRxiv / bioRxiv API
- **Type:** preprints ביו-רפואיים (לפני peer review)
- **Access:** REST/JSON, ללא auth; `https://api.medrxiv.org/`
- **Reliability:** **6/10** — לא עברו עמיתים; אבל לעיתים מקדימים פרסום של חודשים
- **CRPS coverage:** דליל יחסית. CRPS לא תחום preprint-heavy; אומדן עשרות-בודדות-בשנה. Winston יבדוק בפועל ב-Phase 2
- **Hebrew:** ❌
- **Free/Paid:** חינמי
- **Update freq:** רציף; preprints מופיעים תוך שעות מההגשה
- **Verification:** 🟡 needs online verification (היציבות של ה-API טובה היסטורית, אבל הפורמט המדויק להחזרת CRPS-only הוא מה ש-Winston יחתום עליו)
- **המלצה:** מקור משני — surfacing מותנה ב-Tier 2 framing ("preliminary, not yet peer-reviewed").

#### Cochrane Library
- **Type:** סקירות שיטתיות (evidence synthesis — gold standard לראיות)
- **Access:** **אין API ציבורי שאני מכירה.** abstracts קריאים בחינם דרך הדפדפן; full text דורש מינוי
- **Reliability:** **10/10** איכות; **3/10** נגישות מכאנית
- **CRPS coverage:** סקירות בודדות (CRPS בכלל, neridronate, ketamine, mirror therapy) — מתעדכנות לאט (פעם בשנים)
- **Hebrew:** ❌
- **Free/Paid:** abstracts חינם, full text משולם
- **Update freq:** איטית (חודשים-שנים) — אבל כל פרסום חדש משמעותי מאוד
- **Verification:** 🟡 needs online verification — ייתכן שיש RSS לעדכונים חדשים; Winston יבדוק
- **המלצה:** monitor ידני (בדיקה תקופתית ע"י crawler קל) או ויתור ב-MVP. הופעות של Cochrane על CRPS — אירועים נדירים אבל קריטיים, שווים להוציא לדף נחיתה אישי.

#### Google Scholar
- **Type:** סורק אקדמי כללי
- **Access:** ❌ **אין API רשמי**. SerpAPI/Scholarly.py = scraping פגיע, נגד ToS
- **Reliability:** **N/A** ככלי תכנותי
- **המלצה:** **לא להשתמש** ב-MVP. PubMed מכסה את המוסדות הביו-רפואיים; Scholar היה מוסיף בעיקר רעש.

### 1.2 Israeli sources — עברית/מקומיים

> **הערה כוללת:** סקירת מקורות ישראליים בלוויית CRPS היא נקודת החולשה המבנית. רובם **אין להם API ציבורי, אין RSS, ואין endpoint יציב לפיתוח**. מה שיש — דורש scraping של HTML מתחלף, או הסתפקות בכך שניסויים ישראליים מתפרסמים גם ב-`ClinicalTrials.gov`. Winston ישקול ב-Phase 2 אם להוסיף Browserless בעתיד או לוותר ב-MVP.

#### משרד הבריאות — אישורי תרופות / "סל התרופות"
- **Type:** הודעות רגולטוריות
- **Access:** דף `https://www.health.gov.il/` (HTML, ללא API)
- **Reliability:** **10/10** מקור רשמי; **2/10** נגישות מכאנית
- **CRPS coverage:** חלקית — תרופות חדשות לכאב כרוני (gabapentinoids, ketamine, neridronate בעתיד) ייכנסו דרך הסל. אזכורי CRPS ספציפיים נדירים
- **Hebrew:** ✅
- **Free/Paid:** חינמי
- **Update freq:** הכרזות סל תרופתי שנתיות + הודעות נקודתיות
- **Verification:** 🔴 likely unavailable — אין סיבה להניח endpoint נגיש; scraping יידרש או ויתור
- **המלצה:** לא MVP. Winston יחליט אם להוסיף בשלב מאוחר יותר.

#### משרד הבריאות — מרשם ניסויים קליניים
- **Type:** מרשם משרדי ייעודי (אם קיים נפרד מ-ClinicalTrials.gov)
- **Verification:** 🟡 needs online verification — לא ברור לי מהריפו ומהידע שיש לי אם קיים רישום נפרד ופעיל בעברית. Winston יבדוק
- **המלצה:** סביר שכמעט-תמיד תהיה חפיפה עם `ClinicalTrials.gov?country=Israel`. אם יש מרשם נפרד אקסקלוסיבי — Winston יחליט אם לשלב

#### קופות חולים (כללית, מכבי, מאוחדת, לאומית) — פלטי מחקר
- **Type:** הודעות לעיתונות, דוחות שנתיים, מחקר מוסדי
- **Access:** אתרי PR (HTML); אין API ידוע
- **Reliability:** **6/10** — איכות מעורבת (חלק PR שיווקי, חלק מחקר רציני)
- **CRPS coverage:** **דלילה מאוד**. קופות מפרסמות עבודות על כאב כרוני בכלליות, CRPS-specific כמעט ואין
- **Hebrew:** ✅ ברובו
- **Free/Paid:** חינמי
- **Update freq:** ספוראדי
- **Verification:** 🔴 likely unavailable כמקור תכנותי; 🟡 ייתכן feed RSS מקומי (Winston יבדוק)
- **המלצה:** לא MVP. תוספת ערך נמוכה יחסית למאמץ הנדרש.

#### מרפאות כאב — איכילוב, שיבא, רמב"ם, הדסה, סורוקה
- **Type:** דפי מוסד
- **Access:** HTML; חלקם עם newsletters
- **CRPS coverage:** מרפאות הכאב הגדולות (איכילוב — מרכז הכאב; שיבא — שיקום) רוקרוטות לניסויים שייכנסו ל-`ClinicalTrials.gov` — שם נראה אותם בלי לסקרר
- **Verification:** 🟡 needs online verification ל-newsletter feeds
- **המלצה:** **שאיבת ערך עקיפה דרך `ClinicalTrials.gov?country=Israel`** היא הגישה הנכונה ל-MVP. סקרייפינג ישיר נדחה.

#### האיגוד הישראלי לרפואת כאב (medical society)
- **Type:** איגוד מקצועי של רופאים
- **Verification:** 🟡 needs online verification — ייתכן שמפרסם הצהרות עמדה / כינוסים
- **המלצה:** monitor ידני אופציונלי; לא MVP.

#### ארגוני מטופלים בעברית
- **Verification:** 🟡 needs online verification — אני לא מאמתת מתוך הידע שיש לי קיום של ארגון ישראלי-CRPS פעיל. ייתכן שיש קבוצת תמיכה בכאב כרוני כללי, **אבל הברית של שילו אסר על patient anecdotes ופורומים** — לכן גם אם קיים, הוא **לא יישאב** בלי סינון Tier 3 קשוח.
- **המלצה:** דחייה.

### 1.3 ארגוני מטופלים בינלאומיים (research-grade בלבד)

#### RSDSA (Reflex Sympathetic Dystrophy Syndrome Association)
- **Type:** ארגון מטופלים אמריקאי + פוקוס מחקר
- **Access:** אתר `https://rsds.org/`. יש newsletter ובלוג; RSS feed = 🟡 needs online verification
- **Reliability:** **8/10** למחקר, **5/10** לאזורים פטיינט-אנקדוטיים שלהם (אסור לפי הברית)
- **CRPS coverage:** ייעודי
- **Hebrew:** ❌
- **Update freq:** חודשי-עשור
- **Verification:** 🔵 knowledge-verified כקיים ופעיל; 🟡 RSS endpoint דורש בדיקה
- **המלצה:** סנן רק לסקציית research. Winston יוודא endpoint לפני שילוב.

#### Burning Nights CRPS Support (UK)
- **Type:** ארגון מטופלים בריטי
- **Access:** `https://www.burningnightscrps.org/`; קיים בלוג + research updates
- **Reliability:** **7/10** למחקר; שאר התוכן הוא תמיכה רגשית (Tier 3)
- **CRPS coverage:** ייעודי
- **Verification:** 🟡 needs online verification ל-RSS
- **המלצה:** filter קשוח לסעיף research-only. אם אין RSS — לא MVP.

#### IASP — International Association for the Study of Pain
- **Type:** איגוד מקצועי בינ"ל לכאב
- **Access:** `https://www.iasp-pain.org/` — fact sheets בחינם, journal "Pain" משולם
- **Reliability:** **9/10** ערך מקצועי
- **CRPS coverage:** הצהרות עמדה, fact sheets ייעודיים, ועדת CRPS פעילה
- **Hebrew:** ❌
- **Update freq:** איטית (חודשים)
- **Verification:** 🟡 needs online verification ל-RSS/feed; ייתכן שעדכוני "Pain" journal נסרקים בעקיפין דרך PubMed (סביר)
- **המלצה:** אם PubMed מכסה את "Pain" journal — אין צורך כפול. Winston יבדוק.

#### For Grace
- **Type:** קרן ייעודית CRPS
- **Verification:** 🟡 needs online verification לפעילות שוטפת ולקיומו של feed תכנותי
- **המלצה:** monitor ידני אופציונלי; לא MVP.

### 1.4 צינור פארמה (pipeline)

#### ClinicalTrials.gov — סינון Phase 2/3 בלבד
ראה §1.1. סינון `phase=PHASE2,PHASE3` + `condition=CRPS` נותן את המודלים הקרובים-לאישור.

#### FDA OOPD (Office of Orphan Products Development)
- **Type:** מאגר ייעודי designation; CRPS לא orphan classic, אבל תרופות ספציפיות שמטפלות ב-CRPS-subset יכולות לקבל designation
- **Access:** דף חיפוש ב-`https://www.accessdata.fda.gov/scripts/opdlisting/oopd/`; אין API ידוע
- **Reliability:** **9/10** רישום רשמי
- **Verification:** 🔴 likely unavailable כ-API; 🟡 ייתכן שניתן לסקור בתקופתיות
- **המלצה:** monitor ידני רבעוני, לא בלולאת auto-fetch.

#### EMA — European Medicines Agency
- **Type:** רישום אישורים אירופי
- **Access:** `https://www.ema.europa.eu/`; יש RSS לעדכונים
- **Verification:** 🟡 needs online verification ל-feed CRPS-relevant
- **המלצה:** אופציונלי; דריסה גבוהה עם FDA וקלינוויל גלובלית מובילה ממילא.

### 1.5 חוקרים שכדאי לעקוב

זוהי **רשימה התחלתית** של חוקרים שמרבים לפרסם ב-CRPS. **כל פרסום שלהם ב-PubMed מצדיק surfacing אוטומטי** (Tier 1 לפי הקריטריונים בסעיף 4):

| חוקר | מוסד | פוקוס | רמת ביטחון |
|---|---|---|---|
| Norman Harden | Northwestern (US) | תווי אבחון, CRPS Severity Score | 🔵 גבוה |
| Frank Birklein | Mainz (DE) | אטיולוגיה, מנגנונים | 🔵 גבוה |
| Andreas Goebel | Liverpool (UK) | אימונולוגיה, IVIG, autoantibodies | 🔵 גבוה |
| Anne Louise Oaklander | Mass General (US) | small fiber neuropathy → CRPS | 🔵 גבוה |
| Stephen Bruehl | Vanderbilt (US) | ביופסיכוסוציאל, מנבאי תוצא | 🔵 גבוה |
| Mads Werner | Rigshospitalet (DK) | פרמקולוגיה, ketamine | 🟡 בינוני |
| Wade King | אוסטרליה | טיפולים פיזיים | 🟡 בינוני |
| Roberto Perez | אמסטרדם (NL) | רב-תחומי | 🟡 בינוני |
| חוקרים בישראל | ? | ? | 🔴 לא אומת — Winston יבדוק |

> **גילוי-לב:** אני לא יכולה לאמת מהריפו ומהידע הזמין לי שמות של חוקרי CRPS בישראל הפעילים כיום. Winston יחפש רשימה זו ב-Phase 2 דרך PubMed search `"CRPS"[All Fields] AND Israel[Affiliation]`.

---

## 2. PubMed Search Strategy

### 2.1 שאילתת בסיס מומלצת

```
("Complex Regional Pain Syndromes"[MeSH Terms]
 OR "Reflex Sympathetic Dystrophy"[Title/Abstract]
 OR "CRPS"[Title/Abstract]
 OR "RSD"[Title/Abstract]
 OR "causalgia"[Title/Abstract])
AND ("last 90 days"[PDat])
```

**הנמקה:**
- `MeSH Terms` — תופס מאמרים שתוייגו רשמית. מינימום false-positives.
- `Title/Abstract` — תופס מחברים שלא משתמשים במונח MeSH. **אבל:** `RSD` חופף ל-Repetitive Strain Disorder ועוד; ראה §2.3 לאיתור רעש.
- `causalgia` — מונח עתיק לסוג II (נזק עצב), עדיין בשימוש בספרות אנגלית.
- `last 90 days[PDat]` — חלון יחסי, מתעדכן בכל ריצה.

### 2.2 פילטרים לסוג מחקר (לדירוג Tier)

ב-Tier 1 העדפה לסוגי מחקר עם evidence-strength גבוה:

| סוג | פילטר PubMed | משקל ל-Tier 1 |
|---|---|---|
| Randomized Controlled Trial | `Randomized Controlled Trial[Publication Type]` | גבוה |
| Meta-Analysis | `Meta-Analysis[Publication Type]` | גבוה מאוד |
| Systematic Review | `Systematic Review[Publication Type]` | גבוה מאוד |
| Clinical Trial | `Clinical Trial[Publication Type]` | בינוני |
| Review | `Review[Publication Type]` | בינוני (תלוי תוכן) |
| Case Reports | `Case Reports[Publication Type]` | **לא מציגים אוטומטית** — סיכון לאנקדוטה רגשית |

### 2.3 רעש ידוע שצריך לסנן

- `RSD` שאינו CRPS: Repetitive Strain Disorder, Restless Sleep Disorder, ועוד — Winston ינסח NOT-clauses לאחר בדיקה אמפירית ב-Phase 2.
- מאמרים על מודלים בחיות בלבד — לא רלוונטיים לסיוע יומיומי. סינון אופציונלי דרך `humans[MeSH]`.

### 2.4 עברית

PubMed מכיל מקור עברי מינימלי. אסטרטגיית עברית = **תרגום כותרת/תקציר מ-English ל-Hebrew דרך Gemini בעת הצגה**, לא חיפוש בעברית. ראה גם §6 — שאלת translation היא Q10 בסעיף 9.

### 2.5 הזרמת תוצאות

`esearch.fcgi` מחזיר רשימת PMIDs → `efetch.fcgi` מחזיר metadata + abstract בפורמט XML או JSON. רכיב הסקילי יחזיק מצב "last seen" (timestamp של שאילתה אחרונה) כדי לא להציג שוב את אותם מאמרים. ראה Q4 בסעיף 9.

---

## 3. Treatment Categories — קטגוריות טיפול ומפת מחקר

| קטגוריה | טיפולים | קצב מחקר (papers/yr, אומדן) | סיכוי לפריצת דרך 24–36 חודשים | הערות |
|---|---|---|---|---|
| **תרופתי** | gabapentin/pregabalin, ketamine (low-dose IV), bisphosphonates (neridronate, pamidronate), low-dose naltrexone (LDN), IVIG, cannabinoids | **גבוה** (~50–80) | בינוני | neridronate בקדמת הבמה ב-EU; LDN ב-RCTs קטנים |
| **התערבותי** | sympathetic blocks (stellate / lumbar), spinal cord stimulation (SCS), DRG stimulation, intrathecal pumps (baclofen, ziconotide), epidural | בינוני (~30–50) | נמוך (איטרציה, לא פריצה) | DRG מבוסס היטב — שילו עצמו עם שתל |
| **פיזי / שיקומי** | graded motor imagery (GMI), mirror therapy, pain exposure, desensitization | בינוני (~20–40) | נמוך | גוף ידע יציב; שיפורים שוליים |
| **מתעורר** | Calmare/scrambler therapy, plasma exchange, autologous stem cells, vagus nerve stimulation (VNS), pulsed RF | נמוך–בינוני (~15–25) | **בינוני–גבוה** | מקור Tier 1 פוטנציאלי — מחקרים מוקדמים שיכולים להבשיל |
| **רב-תחומי / נפש-גוף** | Pain Reprocessing Therapy (PRT), ACT, biofeedback, CBT לכאב | נמוך ל-CRPS ספציפי (~10–15) | נמוך | רוב המחקר על כאב כרוני בכלליות, לא CRPS — generalization מוגבל |

**הערות חשובות:**
- האומדנים הם גסים, מבוססי ידע על שדה הכאב הכרוני בעשור האחרון. Winston יאמת ב-Phase 2 דרך שאילתת PubMed לכל קטגוריה.
- "פריצת דרך" כאן = הוכחה ב-RCT >100 משתתפים של יעילות משמעותית, או רישום רגולטורי. לא פתרון מלא.
- **LDN, neridronate, ו-VNS** הם המועמדים האטרקטיביים ביותר ל-Tier 1 surface בשנים הקרובות.

---

## 4. Hope Filter Design Research — לב המוצר

הסעיף הקריטי. הברית מגדירה אילוצים רגשיים נוקשים, ובלי מסנן רגשי טוב המוצר יזיק במקום לעזור.

### 4.1 כיצד אפליקציות רפואיות אחרות מטפלות בתוכן רגשי

| אפליקציה | מודל מסנן | רלוונטיות לעיצוב שלנו |
|---|---|---|
| **Curable** | התוכן כולו צוות-מחדש סביב neuroplastic pain (Pain Reprocessing). אין הזרמת מחקר חיצוני; כל תוכן עבר עיצוב מקצועי-רגשי | **גבוהה** — דוגמה לעיצוב שמסיר תוכן רגשי-מאיים מהמשוואה |
| **Pathways** | הכשרה מודרכת לכאב כרוני; פוקוס neuroplasticity; אין feed מחקר | בינוני — מודל שדומה ל-Curable, פחות רלוונטי כי שלנו = aggregator |
| **PainScale** | מעקב + תוכן חינוכי. תוכן נבחר ידנית; אין aggregator אוטומטי | נמוך |
| **Calm** | meditation, אין תוכן רפואי כלל | לא רלוונטי |
| **Wellpath** | 🟡 needs online verification — אינני בטוחה במצבו הנוכחי | — |

**מסקנה:** **אין אפליקציה שעושה aggregation אוטומטי של מחקר CRPS עם hope filter**. זה הפער שהמוצר ממלא.

### 4.2 שורשים אקדמיים — informed hope ולא false hope

- **Salander et al.** (פרסומים על תקווה במחלות קשות, נחשבים מסגרת מקצועית) מבחינים בין "hope" כתפיסת אפשרות לבין "false hope" כתחזית מנותקת מראיות. עיצוב Tier 1 של המוצר חייב **להציג רק התקדמויות מבוססות-ראיות**, לא הבטחות.
- **Iatrogenic harm from medical information consumption** — תיעוד אקדמי בכאב כרוני (Cochrane וביקורות אחרות) על כך שחשיפה למידע אבחנתי שלילי גורמת nocebo, מחמירה כאב, ופוגעת בעבודה השיקומית. זה ההצדקה המבוססת-ראיות לתיר 3.
- **Health communication framing research** מצביעה שניסוח חיובי-מנוצח-במציאות ("the trial reduced pain in 40% of participants") עדיף ניסוחית על ניסוח תוצאתי-שלילי ("60% of participants did not respond"), גם אם המידע זהה.

### 4.3 ה-rubric המוצע — 3 דרגות

#### Tier 1 — Surface immediately (Hope-positive)

מאמר/הודעה שמשתייכים אם ורק אם **מתקיים לפחות אחד**:
- ✅ ניסוי קליני ש**מגייס** מטופלים (recruiting), במיוחד בישראל
- ✅ תוצאות חיוביות מ-RCT/meta-analysis לטיפול קיים או חדש
- ✅ הבהרת מנגנון ביולוגי שמובילה לכיוון טיפולי חדש
- ✅ אישור רגולטורי (FDA/EMA/משרד הבריאות) לטיפול חדש
- ✅ נתוני remission ארוכי-טווח חיוביים
- ✅ פרסום של אחד מהחוקרים-המוסדיים מ-§1.5

**דוגמאות (נכונות לתבנית, לא בהכרח לעובדות):**
- "Phase 2 RCT: low-dose naltrexone reduces CRPS pain scores by 38% over 12 weeks" → **Tier 1**
- "Recruiting in Israel: pulsed radiofrequency for refractory CRPS at איכילוב" → **Tier 1** (+ דגל Israeli)
- "Goebel et al.: IVIG mechanism in CRPS clarified" → **Tier 1**

#### Tier 2 — Surface with framing (mixed/early)

מתאים אם:
- 🟡 תוצאות מעורבות (משופר אבל לא מובהק סטטיסטית; subset שעבד וsubset שלא)
- 🟡 Phase 1 או pilot studies — early-phase
- 🟡 טיפול קיים שדורש נחיותיות (caveats סבירים)
- 🟡 מאמרי review שמסכמים מצב ידע כללי

**framing technique:** הוצאה לפועל באמצעות classifier שמייצר משפט הקשר: "Early phase 1 — promising but small sample". המשתמש יראה את הכותרת + ה-framing + קישור.

**דוגמאות:**
- "Mixed results for ketamine infusion in CRPS: 50% responders" → **Tier 2** (framing: "Half of participants benefited; ongoing question for whom this works best.")
- "Pilot study: VNS in 12 CRPS patients shows preliminary improvement" → **Tier 2** (framing: "Very early — small group, no control.")

#### Tier 3 — Block by default (per hard constraints)

חוסם ללא סייג:
- ❌ נתוני נכות / איכות חיים שליליים בלי angle של פתרון
- ❌ נתוני התאבדות / תמותה
- ❌ "המחלה הכואבת ביותר" framing
- ❌ אנקדוטות פציינטים (Reddit, Facebook, פורומים)
- ❌ תחזיות פרוגנוזה ("X% של חולים מתדרדרים")
- ❌ תיאורים גרפיים של כאב או "worst case"
- ❌ פוקוס על תופעות לוואי של תרופות (אלא אם המשתמש שאל ספציפית)

**דוגמאות:**
- "Suicide rates in CRPS patients" → **Tier 3 — block**
- "CRPS prognosis after 10 years: disability statistics" → **Tier 3 — block** (מותר רק אם מוצג כהקשר ל-finding חיובי)
- "Patient describes living with CRPS" → **Tier 3 — block** (אנקדוטה)

### 4.4 יישום מכאני של המסנן

#### 4.4.1 LLM classifier inline בקריאת `/research`

**Prompt schema (תיאור פונקציונלי, Winston יחתום על גרסת final):**

```
אתה מסווג פרסומים מדעיים על CRPS לפי 3 דרגות.
INPUT: כותרת + תקציר + מטא-דאטה
OUTPUT: JSON
{
  "tier": 1 | 2 | 3,
  "framing_he": "<משפט הקשר בעברית, רק אם tier=2>",
  "block_reason": "<קוד סיבה, רק אם tier=3>",
  "rationale": "<משפט קצר באנגלית להסבר פנימי לוג>"
}
חוקים: <הברית של שילו, מצוטטת>
```

#### 4.4.2 שכבה דטרמיניסטית — keyword pre-filter לפני LLM

Block-list cheap (לפני שמבזבזים טוקנים):
- "suicide", "התאבדות"
- "disability rate", "אחוז נכות"
- "most painful", "הכאב הנורא ביותר"
- ועוד ~10 ביטויים שתסכמו עם Winston ב-Phase 2

מאמר ש-pre-filter חוסם → לוג ב-`research_blocked_log` בלי קריאת LLM. חוסך טוקנים והוא דטרמיניסטי-מאומת.

#### 4.4.3 לוג שקיפות — `research_blocked_log`

לכל מאמר חסום (גם pre-filter, גם LLM Tier 3):
- `id, source, title, url, blocked_at, reason_code, classifier_rationale`

**הצדקה:** אתה (שילו) יכול לבדוק תקופתית מה הסתננו → לכוון את ה-rubric. בלי הלוג הזה, המסנן הופך לקופסה שחורה ויש סיכון של filter-overshoot (חסימת תוכן ראוי).

### 4.5 בדיקת tail — מה קורה כשטיפול שאתה לוקח מתערער במחקר?

תרחיש קצה: מחקר חדש מציע ש-DRG stimulation פחות יעיל ממה שחשבו (DRG = הטיפול שלך). הכלל מהברית: **המערכת לעולם לא ממליצה להפסיק טיפול נוכחי**.

**הנחיה ל-classifier:** מאמר שמערער טיפול קיים שנמצא בפרופיל המשתמש → **Tier 2 עם framing נטרלי** ("New evidence on DRG long-term outcomes — discuss with your treating team if relevant"). לא Tier 1 (לא 'hope'), לא Tier 3 (לא חסימה — המשתמש זכאי למידע), אלא Tier 2 עם framing אחראי.

זוהי החלטת מוצר, לא טכנית. Q12 בסעיף 9.

---

## 5. Tooling Investigation

### 5.1 גישה למקורות לפי דרישת תשתית

| גישה | מקורות | תשתית נדרשת |
|---|---|---|
| HTTP פשוט | PubMed, ClinicalTrials.gov, medRxiv | ה-`fetch` המובנה ב-Node, או axios; אין צורך בכלום נוסף |
| RSS | RSDSA?, Burning Nights?, IASP?, EMA? | חבילה כמו `rss-parser` (קלת משקל); כל ה-RSS endpoints דורשים אימות אינדיבידואלי 🟡 |
| HTML scraping (no JS) | חלק מאתרי משרד הבריאות, מרפאות כאב | `cheerio` (קלת משקל) |
| **JS-heavy scraping** | אתרים המבוססי SPA — לא נדרש ב-MVP | Browserless ($10–25/חודש לפלאן הקטן ביותר) — **הצעה: דחייה, לא MVP** |

**עלות תשתית MVP: $0** — כל מקור MVP נגיש דרך HTTP/JSON או RSS.

### 5.2 עלות סינון LLM

הבוט משתמש ב-Gemini 2.5 Flash כ-fallback (לפי `CLAUDE.md`). תמחור Flash (אחרון שאני מודעת לו, 🟡 Winston יאמת): ~$0.075/M input + $0.30/M output. למאמר טיפוסי:

- input ≈ 500 טוקנים (כותרת + תקציר + מטא)
- output ≈ 100 טוקנים (JSON עם tier + framing + rationale)
- עלות ≈ **$0.000067 למאמר**

ב-100 מאמרים בחודש (אומדן גס לקריאות `/research` ושאילתות חיפוש): **~$0.007 לחודש**. נכלל לחלוטין ב-free tier הקיים של Gemini הבוט.

### 5.3 שילוב במבנה הקיים — CORE vs EXTENDED

`bot/agent.js:386` מכיל את ה-comment `// ── Split tools: CORE (always sent) vs EXTENDED (sent only when relevant)`. **המסקנה:** הכלים החדשים של ה-skill (`research_query`, `research_subscribe`, וכו') חייבים להירשם ל-EXTENDED בלבד. CORE הוא token economy של הבוט — המשתמש נותן לבוט מאות אינטרקציות יומית; הוספת tools ל-CORE = הוספה קבועה של טוקנים לכל קריאה.

**מבנה skill מוצע (Winston יחליט בפועל):**

```
skills/
  research/
    SKILL.md                 # תיאור human-readable
    index.js                 # exports { name, description, tools, execute }
    sources/
      pubmed.js
      clinicaltrials.js
      medrxiv.js
    filter/
      classifier.js          # LLM call
      keywords.js            # pre-filter
    storage/
      articles.js
      topics.js
      blocked-log.js
```

זה מבנה הצעתי בלבד. Winston ייקבע את העץ הסופי ב-Phase 2.

### 5.4 Storage — טבלאות חדשות מוצעות

| טבלה | עמודות עיקריות | RLS | הערות |
|---|---|---|---|
| `research_articles` | `id, source, source_id, title, abstract, url, published_at, fetched_at, tier, framing_he, surfaced_to_chat_id, surfaced_at` | חובה ENABLE + FORCE | המקור-של-אמת לסינדיקציה |
| `research_topics` | `id, chat_id, topic, keywords, created_at` | חובה ENABLE + FORCE | מנויים של המשתמש לנושאים |
| `research_blocked_log` | `id, source, source_id, title, url, blocked_at, reason_code, rationale` | חובה ENABLE + FORCE | לוג שקיפות; ניתן לסקירה ידנית |
| `research_user_profile` (אופציונלי) | `chat_id, profile_he, profile_en, treatments, preferences` | חובה ENABLE + FORCE | אם נשמור פרופיל ב-DB; ראה Q12 |

**חובה הדוקה לפי `docs/security/01f-final-summary.md` Rule 1:** כל מיגרציה שיוצרת טבלה חדשה חייבת להכיל גם `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` וגם `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. **אפס policies** — ה-service_role יגש דרך הבוט, וכולם האחרים חסומים-בברירת-מחדל.

### 5.5 Migration delivery

ה-repo כיום **לא מכיל תיקיית `supabase/migrations/`** (אומת — `ls supabase/` מחזיר "No such file or directory"). מיגרציות הסקיוריטי הוחלו דרך Supabase MCP, לא דרך קבצים בריפו. זוהי **החלטה אדריכלית פתוחה** ל-Winston:

- **(a)** להמשיך באותו מודל — להחיל את המיגרציות לטבלאות החדשות דרך Supabase MCP, ולתעד ב-`docs/research/0Xc-architect-design.md`
- **(b)** ליצור תיקיית `supabase/migrations/` ולהקים מודל מיגרציה רשמי החל מהפרויקט הזה (יתרון: היסטוריה ברורה; חיסרון: שינוי בטכניקה הקיימת — **על גבול האדיטיביות**)

**המלצת Mary:** **(a)** ל-MVP, **(b)** כתכנית עתידית בלי לערב את הריפו עכשיו.

---

## 6. Privacy & Ethics

### 6.1 פרופיל מטופל — מקום אחסון

| גישה | יתרונות | חסרונות |
|---|---|---|
| **`memory` table (existing)** | reuses pattern (`chat_id`-scoped); RLS מוגן כבר; אין מיגרציה חדשה | מתערב מבני בטבלה קיימת — **גובל בלא-אדיטיבי**; משדר תוכן רפואי לאותה טבלה כמו תזכורות יומיומיות |
| **`research_user_profile` (חדש)** | הפרדה לוגית; קל לרוטציה/מחיקה | טבלה נוספת |
| **`.env` בלבד** | לא ב-DB | לא נגיש מכלים אחרים בבוט; קשיח |
| **encrypted column עם pgcrypto** | הצפנה ב-rest | מורכבות מיותרת — service_role-only RLS כבר נותן הגנה תפקודית |

**המלצת Mary:** טבלה ייעודית `research_user_profile` עם RLS מלא, **בלי pgcrypto** (overkill כי service_role + RLS lockdown מספקים את ההגנה). Q12 בסעיף 9 לאישור שילו.

### 6.2 Caching — privacy vs API limits

- **Cache article metadata (title, abstract, url, tier):** ✅ — זה תוכן ציבורי. אין סיכון פרטיות. חוסך rate limit לכל מקור.
- **Cache user-specific queries (filters, results):** 🟡 — אם נחזיק היסטוריית שאילתות, היא חושפת תחומי עניין רפואיים. **המלצה:** לא לאחסן שאילתות מלאות; לאחסן רק `last_seen_at` per topic לדה-דופ.
- **Cache article→chat_id mapping (איזה מאמר הוצג למי):** ✅ עם RLS lockdown — רק service_role מגיע אליו דרך הבוט.

### 6.3 Disclaimer — חובה משפטית/אתית

הצעה לטקסט (עברית, יוצג בכל קריאה ראשונה של `/research` או בעת התקנה):

> ⚕️ **הבהרה:** המידע שמוצג כאן הוא מידע מחקרי כללי, **לא ייעוץ רפואי**. אל תשנה טיפול קיים ללא התייעצות עם הצוות הרפואי המטפל. בחירות טיפוליות הן בידיך ובידי הרופאים שלך — הכלי כאן רק עוזר לעקוב אחר ההתפתחויות.

**הצעה תפעולית:** disclaimer יוצג בקריאה ראשונה של היום (gated על `last_disclaimer_seen` ב-`research_user_profile`).

### 6.4 "המערכת לעולם לא תייעץ להפסיק טיפול"

חוק מקודד ב-system prompt של ה-skill. כל פלט classifier שמרמז על המלצת הפסקה → escalation ל-Tier 2 framing + הוספת המשפט "Discuss with your treating team."

### 6.5 Hebrew medical terminology consistency

מילון פנימי קצר לעקביות (Mary מציעה — Winston יאשר):
- CRPS → CRPS (לא לתרגם, מונח רפואי בינ"ל)
- "complex regional pain syndrome" → "תסמונת כאב אזורי מורכב" (במידה ומוצג טקסט מלא)
- "chronic pain" → "כאב כרוני"
- "nerve block" → "חסם עצב"
- "spinal cord stimulation" → "גירוי חוט שדרה"
- "DRG stimulation" → "גירוי DRG" (השאר אנגלית — מונח רפואי בינ"ל)
- "remission" → "הקלה משמעותית" (לא "הפוגה" — מונח גנרי שעלול להטעות)

זה לא נימצא בשום סטנדרט רשמי — **אני ממליצה לשמור את המילון ב-`docs/research/glossary-he.md`** כקובץ עוקב, לעדכון מצטבר. Q בסעיף 9 (חדש).

---

## 7. Existing Solutions — מה כבר קיים בשוק

| אפליקציה | פוקוס | CRPS-specific? | עברית? | Hope filter? | aggregator מחקר? | קוד פתוח? |
|---|---|---|---|---|---|---|
| Curable | neuroplasticity, pain reframing | ❌ (כאב כרוני כללי) | ❌ | ✅ (מובנה בעיצוב) | ❌ | ❌ |
| Pathways | neuroplastic chronic pain | ❌ | ❌ | ✅ | ❌ | ❌ |
| PainScale | tracking + תוכן חינוכי סטטי | ❌ | ❌ | חלקי | ❌ (curated) | ❌ |
| Calm | meditation | ❌ | חלקית | N/A | ❌ | ❌ |
| RSDSA app | מידע CRPS מאתר הארגון | ✅ | ❌ | ❌ | חלקי (חדשות מהאתר) | ❌ |
| **הכלי הזה (proposed)** | aggregator מחקר CRPS hope-filtered | ✅ | ✅ | ✅ (מרכז) | ✅ | ✅ (פנימי) |

**פערים שהכלי הזה ממלא:**
1. **עברית-first** — אף אחת מהאלטרנטיבות לא תומכת
2. **CRPS-specific** — Curable/Pathways רחבים מדי
3. **Aggregator אוטומטי** — אף אחד מהמתחרים לא עושה syndication של PubMed/ClinicalTrials עם hope filter
4. **משולב בעוזר אישי קיים** — לא דורש אפליקציה נוספת
5. **single-user, no account, no data sharing** — לא צריך להירשם, אין סיכון פרטיות מערכתי
6. **personalizable to user's specific treatment profile** — שתי האחרות (Curable, Pathways) הן מסלול הכשרה כללי
7. **transparent (open log)** — `research_blocked_log` שמאפשר לבדוק מה מסונן

**אזהרה הוגנת:** אני לא מאמתת מצב נוכחי של כל ספק (Wellpath, CRPS UK app) — Winston יבדוק לפני adoption של "אנחנו ייחודיים" כטענה שיווקית פנימית.

---

## 8. Additive-Only Verification

זה הסעיף הקריטי לפי הברית — verification שהכל אדיטיבי. מבוסס על קריאת הקבצים בפועל, לא הנחות.

### 8.1 Skills קיימים

`ls skills/`:

```
README.md
ROADMAP.md
_disabled_ai-news/    ← ה-loader מתעלם בגלל קידומת '_'
news/
vision/
voice/
web-search/
```

**4 skills פעילים.** סקירה אחד-אחד:
- `news/` — לא נוגע
- `vision/` — לא נוגע
- `voice/` — לא נוגע
- `web-search/` — לא נוגע (חופף תפקודית עם `research/`? לא — `web-search` הוא חיפוש כללי, `research/` יהיה ייעודי CRPS עם sources fixed וסינון hope. **אין קונפליקט שמות tools.**)

**`bot/skills-loader.js` (אומת — קראתי את כולו):** סורק את `skills/`, פוסח על `_`-prefixed, דורש `index.js` עם `{ name, tools, execute }`. **הוספת `skills/research/` לא דורשת שינוי ב-loader, ב-`bot/index.js`, או בכל קובץ קיים.**

### 8.2 טבלאות קיימות (12)

מתוך `docs/security/01f-final-summary.md` §"Tables Secured":

```
leads, health_logs, habits, expenses, tasks, passwords,
memory, watchlist, auth_tokens, backups, doc_summaries, image_edits
```

**אף אחת לא משתנה.** הטבלאות החדשות (`research_articles`, `research_topics`, `research_blocked_log`, אופציונלית `research_user_profile`) הן **תוספת בלעדית**.

**Caveat קריטי:** אם Winston יחליט בשלב 2 שעדיף לאחסן את פרופיל המטופל ב-`memory` במקום בטבלה חדשה — זה **שינוי לא-אדיטיבי** של schema קיים (גם אם מבחינת הנתונים זה שורה חדשה, מבחינת ההסכם זה הטמעת תוכן רפואי בטבלה כללית). **אני ממליצה Winston ימנע מזה ויבחר טבלה ייעודית** (Q12 בסעיף 9).

### 8.3 Scheduler jobs (אומת מתוך grep ב-`bot/scheduler.js`, `bot/proactive.js`, `bot/index.js`)

```
bot/proactive.js:20    cron.schedule('30 13 * * 5', ...)    # Friday Shabbat eve
bot/proactive.js:68    cron.schedule('0 21 * * *', ...)     # Daily health reminder
bot/proactive.js:80    cron.schedule('30 5 * * 0', ...)     # Sunday weekly plan
bot/proactive.js:136   cron.schedule('*/30 * * * *', ...)   # Every 30 min (presumed: stocks/leads/sites)
bot/proactive.js:149   cron.schedule('*/30 * * * *', ...)   # Every 30 min (second 30-min job)
bot/index.js:80        cron.schedule('0 3 * * *', ...)      # Daily 3am (UTC)
bot/index.js:127       cron.schedule('0 2 * * 0', ...)      # Sunday 2am (UTC)
bot/scheduler.js:205   cron.schedule('0 4 * * *', sendMorning,         { timezone: 'UTC' })
bot/scheduler.js:208   cron.schedule('0 7 * * *', sendEnglishWord,     { timezone: 'UTC' })
bot/scheduler.js:231   cron.schedule('0 11 * * 5', sendWeeklySummary,  { timezone: 'UTC' })
bot/scheduler.js:256   cron.schedule('0 9 * * *', sendDailyNews,       { timezone: 'UTC' })
bot/scheduler.js:259   cron.schedule('0 19 * * *', sendDailySummary,   { timezone: 'UTC' })
```

**~12 משימות cron.** **אף אחת לא משתנה.** הפיצ'ר על-פי-דרישה (`/research` בלבד) — **אין job חדש כלל**, בהתאם לאילוץ הברית.

### 8.4 כלים ב-CORE tier

`bot/agent.js:386` — מסמן את הקו בין CORE ל-EXTENDED. **כל הכלים החדשים נוספים ל-EXTENDED בלבד.** CORE לא נגוע.

### 8.5 `bot/supabase.js` (service_role architecture)

לא נוגע. ה-skill ייקרא ל-`require('../bot/supabase')` (או הנתיב היחסי הנכון מתוך `skills/research/`) ויקבל את ה-client הקיים. גישה ל-service_role לטבלאות החדשות = ירושה אוטומטית.

### 8.6 `bot/index.js`

**מתבקש: 0 שינויים.** ה-loader אוטומטי. אם בכל זאת Winston יחליט בשלב 2 שצריך הוק ידני (למשל לרישום `/research` slash command), זה ייעשה דרך ה-routing הקיים של slash commands ב-`bot/telegram.js` — ולא בליבת `bot/index.js`. הרישום יוסיף שורה אחת או שתיים, **לא יחליף לוגיקה קיימת**.

**אם בשלב 4 הדבר יתברר כדורש שינוי בליבה — STOP, לפי הברית.**

### 8.7 משתני env

`.env.example` הקיים (בריפו):

```
TELEGRAM_BOT_TOKEN=...
GROQ_API_KEY=...
ALERT_CHAT_ID=...
TELEGRAM_CHAT_ID=758752313
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...
```

**אף אחד לא משתנה.** אם נדרש NCBI API key (אופציונלי, מכפיל את rate limit מ-3 ל-10 req/sec) — **תוספת בלבד**, `NCBI_API_KEY=`. ניסיתי במכוון לא לחייב אותו ל-MVP.

### 8.8 קבצים קיימים מלוכלכים — חייבים להישאר unstaged לאורך כל הפאזות

```
M  bot/image-editor.js
M  data/expenses.json
M  data/health-log.json
M  data/tasks.json
?? data/habits.json
?? data/passwords.json
?? data/stock-watchlist.json
```

**אומת בעת יצירת branch זה:** הקבצים האלה זכו ל-`git checkout -b research/crps-agent-phase1` והם עברו אל ה-branch החדש בלי staging. **שום commit ב-flow זה לא יכלול אותם.** כל phase תאמת מצב זה לפני commit.

### 8.9 מה ידרוש שינוי קיים אם נחליט להוסיף — STOP-list

Mary מסמנת מראש מצבי-קצה שאם Winston יראה אותם ב-Phase 2, **חובה לעצור ולהסלים לשילו**:

1. שינוי schema של טבלה קיימת (למשל הוספת עמודה ל-`memory`)
2. שינוי מבנה loader/routing קיים (למשל אם רוצים `/research` עם syntax מיוחד)
3. שדרוג גרסת `@supabase/supabase-js` שתספיק לשימוש
4. שינוי ב-system prompt הראשי של הבוט שיצריך מיזוג עם ה-skill
5. הוספת cron job (אסור — feature היא on-demand בלבד)
6. שינוי `bot/supabase.js` לכל מטרה
7. שינוי `bot/agent.js` בקטע ה-CORE/EXTENDED tier

אם אחד מאלה צץ — STOP, escalation לשילו לאישור ספציפי.

---

## 9. Open Questions for Shilo (gating לפני Phase 2)

לפני ש-Winston יוכל לתכנן ארכיטקטורה ראויה, יש החלטות שדורשות אותך. סודרו לפי השפעה:

### Q1 — כמות מאמרים לכל קריאת `/research`
- **(a)** 3 מאמרים (Hope-First, mobile-friendly)
- **(b)** 5 מאמרים (איזון ברירת-מחדל)
- **(c)** 10 מאמרים (לטעם של כיסוי שבועי)
- **המלצת Mary:** **(b) 5** ב-Tier 1 + עד 3 ב-Tier 2 = עד 8 פריטים, מינימום צפיפות

### Q2 — Caching מאמרים: cache או fetch fresh בכל קריאה?
- **(a)** Cache אגרסיבי (TTL 6h) → תגובה מהירה, פגיעה קטנה ב-API limits
- **(b)** Fresh בכל קריאה → תוצאות עדכניות, יותר latency, סיכון לרייט-לימיט בעתיד
- **המלצת Mary:** **(a) cache 6h** + dedup לפי `last_surfaced_at` per chat_id

### Q3 — שפה: סיכומים דו-לשוניים (עברית + English) או עברית בלבד?
- **(a)** עברית בלבד (Gemini מתרגם תקצירים)
- **(b)** דו-לשוני (כותרת + סיכום בעברית, link + תקציר באנגלית)
- **(c)** התאמה לפי המקור — עברית למקורות עבריים, English למקורות אנגלית
- **המלצת Mary:** **(b) דו-לשוני** — מבטיח שאתה רואה את התרגום אבל גם יכול להיכנס למקור המקורי

### Q4 — Track מאמרים שכבר הוצגו, או לאפשר חזרות?
- **(a)** Track תמיד — לעולם לא לחזור על אותו מאמר
- **(b)** Allow repeats אם מבקש "tell me again" / "/research --refresh"
- **המלצת Mary:** **(b)** — track ברירת מחדל, יציאה מפורשת ל-refresh

### Q5 — ניסויים ישראליים: contact info ישיר או summary בלבד?
- **(a)** Summary + לינק ל-`ClinicalTrials.gov` בלבד (זהיר משפטית)
- **(b)** + פרטי קשר אם הם publicly listed בניסוי (יעיל אבל גובל בייעוץ)
- **המלצת Mary:** **(a) summary + link**, מהבחינת אחריות. אתה תחליט בפועל אם לפנות.

### Q6 — נושאי מנוי: רשימה מפורשת או נגזרת אוטומטית מפרופיל?
- **(a)** רשימה מפורשת — אתה אומר "ketamine, DRG, neridronate"
- **(b)** אוטומטי — המערכת לומדת מהפרופיל ומוסיפה נושאים רלוונטיים
- **(c)** היברידי — ברירת מחדל אוטומטי + אפשרות לערוך
- **המלצת Mary:** **(c)** — תחילי mode (a) במצב MVP, הצעה לעבור ל-(c) אחרי שבועיים שימוש

### Q7 — טון framing ב-Tier 2 — אופי הניסוח
- **(a)** Clinical neutral (יבש)
- **(b)** Warm-but-honest ("This is early — promising signals, but small sample")
- **(c)** Hope-leaning ("New direction worth watching")
- **המלצת Mary:** **(b)** — מאוזן, מכבד תהליך מחקר, לא over-promising

### Q8 — רשימת keyword-block: לאישור שלך לפני הקפאה
המסנן הדטרמיניסטי (§4.4.2) דורש רשימה. Mary תציע ~10–15 ביטויים ב-Phase 2; אתה תוסיף/תוריד. **רוצה שתהיה ידנית עורכת או ש-Mary תקבע?**

### Q9 — תדירות רענון מקורות (גם אם הקריאה היא on-demand)
- **(a)** מקור נסקר רק כשהמשתמש קורא `/research` (lazy)
- **(b)** רקע פעם ביום בלילה (cron... אבל הברית אסרה proactive cron — **קונפליקט**)
- **(c)** lazy + נשמר במאגר; אם מאגר ריק/ישן TTL — fetch
- **המלצת Mary:** **(c) lazy + cache TTL** — מקיים את האילוץ "no proactive scheduler"

### Q10 — תרגום עברית של תקצירים: Gemini-translate או English bilateral?
חופף ל-Q3 חלקית. **Mary ממליצה: תרגום ע"י Gemini ב-call-time** (חוסך אחסון; מאפשר עידכון אם תרגום משתפר).

### Q11 — פורמט ציטוט
- **(a)** Bibliographic מלא (Vancouver/AMA)
- **(b)** Source-name + URL בלבד
- **המלצת Mary:** **(b)** ל-MVP — קל לקריאה. (a) אופציונלי מאוחר יותר אם תרצה לערוך bibliography.

### Q12 — אחסון פרופיל המטופל
- **(a)** טבלה ייעודית `research_user_profile` (ייחודי, RLS לוקאל)
- **(b)** ב-`memory` הקיים עם key dedicated
- **(c)** רק ב-`.env` (לא DB)
- **המלצת Mary:** **(a) — טבלה ייעודית.** הצדקה: שמירה על אדיטיביות נטו (אילוץ הברית), הפרדה לוגית, מחיקה קלה.

### Q13 — RLS posture לטבלאות החדשות — לאישור פורמלי
**Mary מציעה:** ENABLE + FORCE RLS + **אפס policies** (אותו דפוס deny-by-default מ-`docs/security/01f-final-summary.md`). אישורך לפני Winston יתכנן את המיגרציה.

### Q14 — Glossary in repo?
האם להחזיק `docs/research/glossary-he.md` (mapping מונחים רפואיים אנגלית → עברית; ראה §6.5) כקובץ נפרד?
- **המלצת Mary:** כן, בעדכון מצטבר.

---

## Appendix A — CRPS Reference (terminology grounding)

> **הערה:** אזור זה מציג הגדרות ניטרליות בלבד, להבטחת עקביות מונחים בעבודת Phase 2+. **אין כאן תוכן רגשי, סטטיסטיקות נכות, או prognosis** — בהתאם לאילוץ הברית.

**CRPS (Complex Regional Pain Syndrome) —** תסמונת כאב כרוני המתאפיינת בכאב לא-פרופורציונלי לאירוע המקורי, עם מאפיינים תחושתיים, מוטוריים, אוטונומיים, וטרופיים.

**Subtypes (per IASP):**
- **Type I (formerly RSD):** ללא נזק עצב מובהק
- **Type II (formerly causalgia):** עם נזק עצב מתועד

**Diagnostic frame:** קריטריוני Budapest (IASP) — שילוב של תסמינים מדווחים וסימנים בבדיקה ב-4 קטגוריות (sensory, vasomotor, sudomotor/edema, motor/trophic).

**ICD-10:** G90.50–G90.59 (CRPS); G56.4 (Causalgia of upper limb); G57.7 (Causalgia of lower limb).

**Treatment paradigm (כפי שמופיע באיגודים מקצועיים בינ"ל):** רב-תחומי (פרמקולוגי + התערבותי + פיזי + נפשי). **המסמך הזה לא מציע טיפולים** — הוא מתעד שדה הידע לצורכי הנדסת המסנן.

**מקורות לאישור מונחים:**
- IASP CRPS Special Interest Group — definitions of record
- ICD-10 CM (NLM)
- "Pain" journal (IASP) — review articles

---

## Handoff Note

המסמך הזה **לא משנה דבר בקוד או ב-DB**. הוא תוצר מחקר בלעד.

**What's done:**
- 9 סעיפים מוצקים על נוף המקורות, אסטרטגיית חיפוש, מסנן Hope, כלים, פרטיות, ופתרונות קיימים
- §8 — אימות אדיטיביות מבוסס על קריאת הקוד עצמו (לא הנחות)
- 14 שאלות פתוחות לשילו לפני Phase 2

**What's NOT done (מכוון):**
- אין הצעת ארכיטקטורה (Winston ב-Phase 2)
- אין סכמת DB סופית (Winston)
- אין endpoints מאומתים online (Winston יאמת ב-Phase 2 לפני design)
- אין קוד

**Gating:**
המעבר ל-Phase 2 (Winston) מותנה בתשובות שלך לשאלות Q1–Q14, או באישור מפורש ש-Winston יחליט עצמאית עם המלצות Mary כברירת מחדל.

— Mary 📊
