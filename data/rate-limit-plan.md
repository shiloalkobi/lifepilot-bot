# Feature #8 — Smart Rate Limiting Plan
> BMAD Analysis: Mary (Analyst) + Winston (Architect) | 2026-03-31

---

## 1. מצב קיים — ניתוח

### callLLM() — איך עובד היום
- **Primary**: Gemini 2.5 Flash (כל קריאה רגילה)
- **Fallback**: Groq llama-3.3-70b-versatile (על כל שגיאה/429 מ-Gemini)
- **FORCE_GEMINI=1**: עוקף Groq, 3 retries על 429 מ-Gemini (30s, 60s wait)
- token logging קיים: מודפס בכל callLLM

### rate-limiter.js — מצב קיים
- מונה יחיד בזיכרון: 500 קריאות/יום
- אפס persistence — Render restart = איפוס המונה באמצע יום
- אין מעקב per-provider
- reset בחצות IL (לוגיקת `todayIL()` תקינה)

### מה קורה כשנגמרת המכסה היום
| תרחיש | התוצאה |
|-------|--------|
| 500 קריאות כלליות | canCall()=false → הודעת שגיאה למשתמש |
| Gemini 429 | fallback אוטומטי ל-Groq (שקוף למשתמש) |
| Groq 429 (אחרי Gemini כשל) | throw → handleMessage תופס → "⏳ הגבלת קריאות API" |
| **חסר**: אזהרה ב-80% | **אין** — המשתמש לא יודע עד שהכל קורס |
| **חסר**: מעקב Gemini 250/day | **אין** — הבוט ממשיך לנסות Gemini גם אחרי 250 |
| **חסר**: מעקב Groq 100K tokens | **אין** |

### גבולות אמיתיים
- Gemini 2.5 Flash (free): **250 req/day**, 10 RPM
- Groq llama-3.3-70b: **100K tokens/day**

---

## 2. ארכיטקטורה מוצעת

### עקרון מנחה: Boring & Reliable
> פתרון פשוט שעובד. לא over-engineering.

### WHERE — איפה לשמור
**In-memory + קובץ `data/rate-limit.json`**

- בטעינת השרת: קרא מהקובץ (אם קיים + תאריך זהה)
- בכל עדכון: כתוב לקובץ (אסינכרוני, non-blocking)
- Render restart → קורא מהקובץ → מצב שמור

**מבנה data/rate-limit.json:**
```json
{
  "date": "2026-03-31",
  "gemini": { "requests": 47 },
  "groq": { "tokens": 23400 },
  "alerts": { "gemini80": false, "groq80": false }
}
```

### WHAT — מה לספור
| ספק | מה סופרים | מהיכן |
|-----|-----------|-------|
| Gemini | requests (RPD) | +1 על כל קריאה מוצלחת ל-Gemini |
| Groq | tokens | `res.usage.total_tokens` מה-response |

### WHEN — מתי להזהיר ולחסום

**Gemini (מכסה: 250 req/day):**
| סף | פעולה |
|----|-------|
| 200/250 (80%) | log WARNING + שלח Telegram אחת |
| 237/250 (95%) | דלג על Gemini → ישירות ל-Groq + log [RateLimit] |
| 250/250 (100%) | כמו 95% (אוטומטי) |

**Groq (מכסה: 100K tokens/day):**
| סף | פעולה |
|----|-------|
| 80K/100K (80%) | log WARNING + שלח Telegram אחת |
| 95K/100K (95%) | חסום לגמרי → הודעת שגיאה למשתמש |

### HOW — איפוס
- `todayIL()` קיים ועובד — שימוש זהה לקיים
- בדיקת תאריך בכל increment/read
- אם תאריך שונה → אפס הכל + כתוב לקובץ

### WHERE — חשיפת סטטוס
1. **console.log** בכל callLLM: `[RateLimit] Gemini: 47/250 | Groq: 23K/100K tokens`
2. **כלי חדש** `get_rate_stats` (CORE tool) — מחזיר פירוט למשתמש
3. **Telegram alert** בחציית 80% (פעם אחת ביום per-provider)

### לוגיקת callLLM המעודכנת (pseudocode)
```
callLLM(messages, tools):
  logRateLimitStats()  // console.log מצב

  if FORCE_GEMINI → Gemini עם retry (קיים, רק עדכן ספירה)

  // Primary: Gemini — אבל רק אם לא ב-95%
  if geminiUsage < 237:
    try Gemini → on success: increment gemini count → return
    on error/429: log "falling back to Groq"
  else:
    log "[RateLimit] Gemini 95% — switching to Groq"

  // Groq fallback
  if groqTokens < 95K:
    try Groq → on success: add tokens → return
  else:
    return error "אזל המכסה היומי. מתאפס בחצות."
```

---

## 3. קבצים שיש לשנות

| קובץ | סוג שינוי | תיאור |
|------|-----------|-------|
| `bot/rate-limiter.js` | שכתוב מלא | הוסף per-provider tracking, persistence, thresholds, alert hook |
| `bot/agent.js` | שינוי מינורי | עדכן callLLM() לשאול rate-limiter לפני קריאה; הוסף `get_rate_stats` tool |
| `data/rate-limit.json` | קובץ חדש | נוצר אוטומטית בהרצה ראשונה |

**שינויים ב-rate-limiter.js:**
- `canCallGemini()` — בודק אם < 237
- `incrementGemini()` — מוסיף 1 ל-gemini.requests
- `addGroqTokens(n)` — מוסיף n ל-groq.tokens
- `canCallGroq()` — בודק אם < 95K
- `getStats()` — מחזיר אובייקט סטטיסטיקה מלא
- `formatStats()` — טקסט מפורמט לTelegram
- `persist()` — כותב לקובץ (אסינכרוני)
- `loadFromFile()` — קורא בהפעלה

**שינויים ב-agent.js:**
- callLLM: הוסף בדיקת `canCallGemini()` לפני Gemini call
- callLLM: הוסף `addGroqTokens()` אחרי Groq success
- callLLM: הוסף log שורה אחת של סטטוס
- TOOL_DECLARATIONS: הוסף `get_rate_stats`
- CORE_TOOL_NAMES: הוסף `get_rate_stats`
- executeTool: הוסף case לכלי החדש

---

## 4. הערכת סיכונים

| סיכון | חומרה | הפחתה |
|-------|-------|-------|
| race condition בכתיבה לקובץ | נמוך | בוט single-user, סדרתי |
| I/O overhead בכל קריאה | נמוך מאוד | ~1ms, אסינכרוני |
| Telegram alert חסר chatId | בינוני | TELEGRAM_CHAT_ID כבר קיים ב-env |
| אי-דיוק ב-token count של Groq | נמוך | usage.total_tokens תמיד מגיע ב-response |
| Render לא שומר data/ בין deploys | בינוני | יש persistent disk אם מוגדר; אחרת מתחיל מ-0 |

---

## 5. חיסכון בטוקנים / יתרונות

- מניעת silent failures שגורמים ל-429 לאחר מכסה
- מניעת ניסיון Gemini אחרי 250 (חוסך latency של failed call)
- נראות מלאה: המשתמש יודע מצב המכסה לפני שהכל קורס
- האזהרה ב-80% מאפשרת "להשתמש פחות" עד חצות

---

## 6. מה לא משנים

- לוגיקת `canCall()` / `increment()` הכללית (500/day) — נשארת כ-safety net
- `sanitizeHistory`, `toOpenAIHistory`, כל שאר agent.js — ללא שינוי
- מבנה skills, tools, proactive scheduler — ללא שינוי
