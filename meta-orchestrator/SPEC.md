# פרומפט בנייה v2: מנהל-על לומד (Learning Meta-Orchestrator)

> **מקור-האמת (source of truth) לפרויקט.** קובץ זה מתאר את הארכיטקטורה המלאה והשלבים.
> הבנייה בפועל מתבצעת דרך `BUILD-CHECKLIST.md`, Milestone-אחר-Milestone.
>
> **מה השתנה מ-v1:** נוסף **Decision Engine** מרכזי שמאחד את כל ההחלטות; נוספה **טקסונומיית משימות**;
> נוספו **מכניקת-למידה נכונה** (bandit/Bayesian, exploration), **שלמות-אותות** (העדפה≠אמת, confidence
> חלש, decay), הגדרות ל-**verify()**, ל-**Critic מול Verifier**, ל-**Planner**, ול-**Post-mortem**,
> וכן **provenance, versioning ו-decision records**. הכל **ממוין לשלבים** כדי שה-MVP יישאר רזה.
>
> **משמעת-על:** אל תבנה את כל השכלולים ב-Phase 1. רוב התיקונים שייכים לשלבים 2–4. Phase 1 בונה רק
> את מה שמסומן במפורש כ-**[P1]**.

---

## 0. מטרה ופילוסופיה

מנהל-על לומד: מקבל משימה, בוחר את הדרך שמניבה את **התוצאה הטובה ביותר**, מבצע, לומד מה עבד,
שומר בזיכרון קומפקטי, ובפעם הבאה משתמש בניסיון במקום להתחיל מאפס.

**עקרונות ליבה** (כולם מיושמים דרך **Decision Engine** אחד — סעיף 4, כך שהם לא מתנגשים):
1. איכות היא היעד; עלות היא בלם נגד בזבוז — לא הקריטריון.
2. קודם ללמוד, אחר כך לחסוך. התחל רחב, מדוד מה עזר, גזום. (פותר cold-start.)
3. הזיכרון הוא עמוד השדרה — משפר איכות *וגם* חוסך טוקנים.
4. **אימות לפני זיכרון.** לקח נכתב רק אחרי שאות-הצלחה אישר אותו.
5. סינתזה קוהרנטית = מודל יחיד. ריבוי מודלים = הרחבת חיפוש וביקורת בלבד.
6. שמות מודלים לא מקודדים — רק דרך Registry.

---

## 1. ארכיטקטורה (יעד) — בנייה בשלבים

```
Interface (CLI כמו Claude Code)
        │
        ▼
Request Classifier ── ממפה משימה לטקסונומיה (סעיף 2). סיווג provisional וניתן-לעדכון תוך כדי ריצה.
        │
        ▼
Policy + Autonomy + Budget Engine (סעיף 9)
        │
        ▼
Orchestrator (LangGraph) ── owner ההחלטות. קורא ל-Decision Engine בכל צומת-בחירה.
        │
        ├──► Decision Engine (סעיף 4) ── פונקציית-תועלת אחת שמנקדת כל אפשרות
        │
   ┌────┼───────────────┬───────────────┬────────────────┐
   ▼    ▼               ▼               ▼                ▼
Memory  Model Gateway  Tool Gateway   Adaptive Ensemble  Planner
Spine   + Registry     (MCP/API+sec)  (סעיף 7)           (סעיף 12)
        │
        ▼
Verification Layer (verify(), סעיף 5.4)
        │
        ▼
Single Synthesizer ── נבחר ע"י Orchestrator לפי Decision Engine
        │
        ▼
Independent Verifier (בודק, לא כותב מחדש)
        │
        ▼
Post-mortem (סעיף 5.7) ── predicted מול actual → root cause → עדכון זיכרון
        │
        ▼
Action Gateway (הרשאות, סעיף 10)
```

מנוע: **LangGraph** (state ב-PostgreSQL, checkpoints, durable execution, human-in-the-loop). מסגרות
ספק = workers/adapters בתוך node בלבד.

---

## 2. טקסונומיית משימות [P1 — קריטי]

כל הזיכרון מפתחו על "סוג-משימה", אז חייבים להגדיר מהו. משימה מסווגת ל**מספר תוויות** (multi-label),
לא אחת. הגדר טקסונומיה היררכית + **ממדי-רוחב** שחוצים אותה:

**היררכיה (דוגמה — הרחב לפי הצורך):**
```
Software: Debug | Architecture | CodeReview | Feature
Research: Scientific | Market | Legal | Financial
Creative: Image | Video | Marketing | Copy
Data:     Scraping | Analysis | ETL
Writing:  Spec | Report | Message
```
**ממדי-רוחב (מתויגים לכל משימה):** `verifiable?` (כן/לא/חלקי) · `risk` (low/med/high) ·
`needs_live_data?` · `latency_tolerance` · `context_size` · `subjective_dimension?`

מפתח ה-playbook = שילוב (סוג + ממדי-רוחב הרלוונטיים). "שכתוב חוזה" = `Writing:Spec` + `Legal` +
`risk:high` + `verifiable:partial`. הסיווג נעשה ע"י ה-Classifier, **ניתן לעדכון תוך כדי ריצה** (סעיף 8).
ל-Phase 1 — הגדר טקסונומיה מינימלית שמכסה את משימת-הזרע שנבחרה בלבד.

---

## 3. Use Case ראשון + קורפוס-זרע

ארכיטקטורה task-agnostic; אך צריך משימות אמיתיות לאימות הלמידה. קורפוס-זרע: ניטור-רכש (verifiable),
פיצ'ר Shifts (verifiable), קריאייטיב שיווקי (subjective), ניתוח-מניות (מעורב). **Phase 1: משימה אחת
verifiable** (המלצה: ניטור-רכש/Shifts — אות-הצלחה נקי).

---

## 4. Decision / Utility Engine [P1 — הרכיב המרכזי]

**זה התיקון החשוב ביותר.** במקום עקרונות שמתנגשים וחוקים נקודתיים, כל בחירה (איזה מודל, האם להתייעץ,
כמה מודלים, מתי לעצור, איזה synthesizer, האם לבקש אישור) עוברת **פונקציית-תועלת אחת**. כל אפשרות
מקבלת ציון:

```
Utility(option) =
     w1 · P(success | task_type, history)      # הסתברות-הצלחה מהיסטוריה מאומתת
   + w2 · ExpectedQuality
   + w3 · EvidenceStrength
   + w4 · UserPreferenceFit                     # רלוונטי בממד סובייקטיבי
   − w5 · (Cost + TimePenalty)
   − w6 · Risk
   − w7 · Uncertainty
```

- ה-Orchestrator בוחר את האפשרות עם ה-Utility הגבוה, בכפוף לתקרות-תקציב (סעיף 9).
- **Cost/Benefit מובנה כאן:** שיפור של נקודה אחת באיכות תמורת עלות כפולה יוצא ב-Utility שלילי אלא אם
  w5 נמוך — כך המערכת *לא* מצדיקה פאנל ענק על שיפור זעיר.
- המשקלים `w1..w7` הם config לכל סוג-משימה, ונלמדים לאורך זמן.
- **זה ה-owner של הבחירה** (עונה לנקודות 1, 14, 21): Router/Registry/Ensemble/Aggregator לא מחליטים
  לבד — הם מספקים קלטים ל-Decision Engine.

ל-Phase 1: מספיק גרסה פשוטה (2–3 איברים: P(success), cost, risk). ההרחבה המלאה בשלבים מאוחרים.

---

## 5. עמוד השדרה: זיכרון + אימות [P1]

### 5.1 מבנה מדורג
Tier 1 **Core Playbook** קומפקטי (תמיד-בהקשר): לכל סוג-משימה — מה עבד, מודלים/כלים, עלות, ממה להימנע,
מזהה-פרטים. **קוראים את זה במקום את כל ההיסטוריה** = חיסכון הטוקנים. Tier 2 שכבת-שליפה (פרטים מלאים,
נשלפים לפי צורך). כלים: Letta (התאמה קרובה), Mem0 (קל), Zep/Graphiti (טמפורלי, סעיף 11). procedural
memory עדיין early-stage — לוגיקת-הכתיבה נבנית מותאם.

### 5.2 סוגי זיכרון
Procedural (playbooks — הלב) · Semantic (עובדות יציבות) · Episodic (ריצות עבר) · Working (state הריצה).

### 5.3 אות-הצלחה — נלמד לכל סוג-משימה, עם הפרדת ממדים [P1]
**הפרדה קריטית (נקודה 5):** בתוך משימה אחת מפרידים:
- **ממד אובייקטיבי** (קוד תקין? מחקר עובדתית-נכון? מספר נכון?) → **אימות תמיד רץ. העדפת-משתמש לא
  מבטלת אותו.** משתמש שאהב קוד פרוץ — האבטחה עדיין נכשלה.
- **ממד סובייקטיבי** (הלוגו מוצא חן? הסרטון שיווקי מספיק?) → **כאן העדפת-המשתמש *היא* האמת**, אין
  אמת אחרת. האות = אישר / ביקש תיקון, ו*מה* ביקש.

### 5.4 ממשק Verification [P1] (נקודה 6)
כל אימות מחזיר מבנה אחיד — אף node לא ממציא אימות משלו:
```
verify(artifact, task_type) -> {
  passed: bool,
  confidence: float,
  evidence: [...],
  blocking: bool,        # האם כישלון חוסם המשך
  failure_category: enum # ראה 5.6
}
```

### 5.5 שלמות-אותות (אנטי-זיהום) [עקרון P1, יישום מלא בשלבים]
- **confidence של מודל = אות חלש בלבד** (נקודה 13): LLMs לרוב לא-מכוילים, בטוחים גם כשטועים. הסתמך
  בעיקר על אימות-חיצוני + ביצועי-עבר + איכות-ראיות.
- **אות implicit = משקל קטן** (נקודות 4, 18): "המשתמש השתמש בפלט" עשוי לנבוע מלחץ-זמן, לא מאיכות.
- **decay לפידבק סובייקטיבי** (נקודה 4): בחירה בודדת אינה אות חזק (אולי מיהר/עייף). דורשים מספר
  אישורים עקביים לפני שקובעים "הסגנון הזה מנצח", ומדעכים משקל של אירועים ישנים.

### 5.6 טקסונומיית כישלון [P1] (נקודה 24)
"כישלון" אינו יחיד; כל קטגוריה מעדכנת זיכרון אחרת:
`TestsFailed` · `UserRejected` · `TooExpensive` · `TooSlow` · `CorrectButIncomplete` · `FactualError`.

### 5.7 Post-mortem / Reflection [P1 מינימלי] (נקודה 22)
אחרי כל ריצה: השווה **predicted מול actual** → **root cause** → **עדכון זיכרון** לפי סוג-הכישלון.
זה לב "מערכת לומדת" — בלי זה אין למידה אמיתית.

### 5.8 Decision Records [P1] (נקודה 23)
תעד לכל ריצה **למה** נבחרה דרך (איזה מודל, למה, ציון-Utility). כשתראה ירידת-ביצועים בעתיד — כך תדע
אם הסיבה שינוי-מודל, שינוי-נתונים או ניתוב שגוי.

### 5.9 Versioning + Staleness [Versioning: P2 · Staleness-hook: P1] (נקודות 3, 10)
- **Playbook versioning + rollback:** נכנס כלל רע → אפשר לחזור ל-v קודם.
- **מדיניות staleness מפורשת:** לכל רשומה confidence + תאריך-review. **טריגר לשחרור-מודל חדש** (סעיף
  11): לא למחוק אוטומטית — להוריד confidence ולסמן ל-re-eval. מחיקה רק אחרי ש-eval הראה נחיתות.

### 5.10 כתיבה-לזיכרון
חילוץ → סיווג → כפילויות → **בדיקת אות-הצלחה (5.3)** → confidence → תפוגה → (קריטי) אישור. **כותבים רק
אחרי אישור.**

---

## 6. מכניקת-למידה נכונה [Bandit-core: P1 · Exploration: P3] (נקודות 15, 16, 17, 19)

**החלפת "מי שניצח פעם אחת מנצח תמיד" בעדכון סטטיסטי נכון:**
- לכל (task_type, model) החזק **הערכה Bayesian** (Beta-Binomial על שיעור-הצלחה מאומת), או bandit
  (Thompson sampling). ניצחון בודד מזיז את ההערכה מעט, לא ל-100%. **[P1]** — קריטי כדי שה-MVP ילמד נכון.
- **Exploration (ε≈5%)** [P3]: גם אחרי התכנסות, נסה מדי פעם מודל/כלי אחר. פותר את מלכודת-הנעילה
  (Claude ניצח 10× → מפסיק לבדוק → GPT השתפר → לא מגלה).
- **Cold-start policy** [P3]: לסוג-משימה חדש — פאנל התחלתי קבוע וקטן (2–3 מודלים מספקים שונים; N בקונפיג),
  ואז גיזום. (עקבי עם effort-scaling: 1 לפשוט, 2–4 להשוואה, 10+ למחקר מורכב.)

---

## 7. Ensemble אדפטיבי בין-ספקי [P4] (לא debate נאיבי)

הערך מכשלים *משלימים*, לא מכמות. בנה כך (שלב מאוחר — Phase 1 הוא סוכן יחיד):
1. Router מסווג (סעיף 2).
2. **default-on בלמידה:** במשימות מורכבות הרץ 2–4 מודלים שונים **עצמאית** (בלי לחשוף תשובות זה לזה).
3. **ניתוח disagreement** לפי תשובות/הנחות/עובדות — לא string similarity.
4. **Adaptive escalation:** הסכמה + אימות → עצור. disagreement → critic / ביקורת-ממוקדת / כלי-אימות /
   הוסף **מודל משלים אחד** (לא את כל המאגר). הגבל rounds (סיכון drift/collapse).
5. **Aggregation מודע-משלימות** דרך Decision Engine (סעיף 4). ה-aggregator הוא זה שמפיק תוצאה טובה
   *מה-proposers הספציפיים*, לא בהכרח החזק.
6. **Verification > דעה נוספת:** במשימה verifiable — כלי-אימות עדיף על עוד agent.
7. **Co-failure measurement** (נקודה 11): לא ניתן לבטל שגיאות-מתואמות (מודלים אומנו על נתונים חופפים),
   אבל **מדוד אמפירית** מתי כולם הסכימו וטעו (β), שמור ב-Registry, והעדף קבוצות עם co-failure נמוך.
8. **Uncertainty detector** (נקודה 12): הסכמה-פה-אחד ≠ ודאות. שלב עם historical co-failure על שאלות
   נדירות + איכות-ראיות + אימות-חיצוני לפני שקובעים "בטוח".

### Critic מול Verifier (נקודה 7)
- **Critic** [P2] = **מייצר**: מחפש רעיונות/זוויות/edge-cases חסרים.
- **Verifier** [P1] = **בודק**: עובדות, דרישות, constraints, schema. מחזיר מבנה verify() (5.4).

---

## 8. Router provisional [P1] (נקודה 8)

הסיווג הראשוני הוא **best-guess הפיך**, לא שער חד-פעמי. "הכן מחקר" — רק אחרי חיפוש ראשוני יודעים אם
צריך מידע חי. הגרף (LangGraph loops) **מסווג-מחדש ומנתב-מחדש** כשמידע חדש מתגלה.

---

## 9. Model Gateway + Registry [P1 בסיסי] (נקודה 9)

Adapter אחיד + Registry עם retries/fallback/quota/caching/structured-outputs. **חובה provenance על
eval scores** — ציון בלי מקור חסר-ערך:
```
model_id, provider, capabilities, price, latency, context_limit, tool_support,
availability, fallback_model, last_verified,
eval_scores: [{ task_type, score, n_samples, date, source }]   # provenance
```
שמות מודלים רק דרך Registry. ניתוב לפי Decision Engine (סעיף 4).

---

## 10. אוטונומיה + עלות (מתכוונן בזמן-אמת) [P1]

כמו auto ב-Claude Code — המנהל ממשיך לבד עד שהמשתמש נכנס ומאשר. מצבים (החלפה תוך-כדי-ריצה):
**Full-auto** (רץ הכל כולל ייעוץ/כלים בתשלום עד תקרה) · **Ask-on-expensive** (עוצר לפני פעולה יקרה) ·
**Plan-first** (מציג תוכנית+עלות ומחכה). תמיד: **תקרות-תקציב/סבבים קשיחות בקוד** (circuit breakers),
מניעת רקורסיית סאב-סוכנים, ותצוגת עלות/מקורות/כלים בזמן-אמת.

---

## 11. Tool Gateway + אבטחה [P2, פרט להרשאות-בסיס P1]

MCP מרוחק = **Streamable HTTP** (לא SSE); מקומי = stdio. Gateway יחיד: הרשאות, secrets vault (OAuth,
token ייעודי-לשרת, בלי passthrough), timeouts, retry, rate limits, סיווג-סיכון, audit, סינון injection.
- כל תוכן חיצוני = **untrusted data**. פלט סוכן-משנה שמסכם תוכן לא-מהימן — לא מקור אמין.
- **מדרג הרשאות:** Read-only / Low / Medium(staging) / **High(שליחה/מחיקה/production/תשלום)=אישור תמיד**.
- סוכני-קוד ב-sandbox: fs מוגבל, network policy, בלי secrets, מגבלת CPU/זיכרון, timeout, rollback, allowlist.

---

## 12. Planner [P1] (נקודה 20)

הגדרה מפורשת: **Plan-then-execute עם task decomposition** (פירוק לתת-משימות עם תלויות → task graph),
ובתוך כל צעד — ReAct (reasoning + פעולה). לא black-box. תת-משימות עצמאיות רצות במקביל; תלויות — טורית.
שכלולים (hierarchical / tree-search) בשלבים מאוחרים אם יידרש.

---

## 13. לולאת עדכון-חדשנות [P5] (Toggleable, שואלת-בחזרה)

בודקת מה התחדש (מודלים/כלים/סקילים), מעריכה מה עובד, מעדכנת Registry/playbook. **Toggleable** (כבה כשאין
משימה). **שואלת-בחזרה:** בהפעלה-מחדש — "לבדוק מה התחדש?" ולא רצה מעצמה. ממצאים בזיכרון **טמפורלי**
(חלון-תוקף, Zep/Graphiti). **פרואקטיבית:** מציעה-לנסות או מאבחנת-שלא-כדאי לפי ביצועי-עבר. מפעילה את
**staleness policy** (5.9) על מודלים ישנים.

---

## 14. Phased Build — מה נבנה מתי (חובה לכבד)

**Phase 1 — MVP:** סוכן יחיד (Planner §12, חיפוש, כלי-קוד, synthesis, אישור-אנושי, tracing) על משימה
verifiable אחת. **עמוד השדרה זיכרון+אימות (§5)** כולל: verify() interface, אות-הצלחה עם הפרדת-ממדים,
טקסונומיית-כישלון, post-mortem מינימלי, decision records, staleness-hook. **Decision Engine v1** (§4,
2–3 איברים). **Bandit/Bayesian update** (§6) — כדי שהלמידה תהיה נכונה מהיום הראשון. Registry בסיסי +
provenance. טקסונומיה מינימלית (§2). **מטרה: להוכיח שהמערכת פותרת סוג-משימה אמיתי ולומדת ממנו נכון.**

**Phase 2 — התמחות:** Research/Coding/Critic workers · Critic מול Verifier · Tool Gateway מלא · playbook versioning.

**Phase 3 — ניתוב חכם:** הרחבת Decision Engine · exploration (ε) · cold-start panel policy · גיזום-התייעצות.

**Phase 4 — Ensemble אדפטיבי:** §7 המלא — co-failure measurement, uncertainty detector, disagreement escalation.

**Phase 5 — אוטונומיה+עדכון:** מצבי-אוטונומיה מלאים, לולאת עדכון-חדשנות (§13), ריצות ארוכות. רק אחרי evals ונתוני-ריצה.

---

## 15. Evaluation ו-Observability [P1]

מדוד **איכות** (דיוק, כיסוי, %טענות-עם-מקור, סתירות, פונקציונליות, פידבק) ו**תפעול** (זמן, קריאות,
tokens, עלות, failures, retries, fallback, %התערבות). tracing מלא (OpenTelemetry/LangSmith), correlation
ID. Judge עם rubric מפורש — לעולם לא מדד יחיד; שלב בדיקות דטרמיניסטיות + schema + benchmark קבוע + review
אנושי במדגם. ה-Post-mortem (§5.7) מזין את זה. **קריטריון סיום Phase 1 (פשוט):** ציון עבר סף / אין טענות
קריטיות לא-מאומתות / 2 סבבים ללא שינוי / תקציב נגמר / נדרשת החלטת-משתמש.

---

## 16. הוראות ל-Claude Code

1. **בנה Phase 1 בלבד. אל תממש שכלולי Phase 3–4** (exploration, co-failure, ensemble מלא) מוקדם.
2. כל שלב: כתוב בדיקות, הרץ, תקן, לפני שממשיכים.
3. הפרד לוגיקת-סוכן (prompts/כלים/ידע) מלוגיקת-תזמור.
4. שמות מודלים — רק דרך Registry.
5. כל בחירה עוברת דרך **Decision Engine** (גם ה-v1 הפשוט), לא חוקים נקודתיים מפוזרים.
6. **שאל את המשתמש לפני:** התחייבות למסגרת/DB, חריגת-תקציב, כל פעולת High-impact.
7. תעד לכל ריצה: עלות, מקורות, כלים, **ו-decision record (למה נבחר)**.
8. Stack מוצע (לא מחייב): FastAPI/TypeScript, LangGraph, PostgreSQL (state), object storage (artifacts),
   pgvector רק לחיפוש-סמנטי, כלי-זיכרון §5.

**עקרון-על:** המערכת הטובה ביותר יודעת מתי מודל, מתי קוד רגיל, מתי לעצור, ומתי אדם — ולומדת זאת מניסיון
מאומת, דרך **פונקציית-תועלת אחת** שמאזנת איכות, עלות, סיכון ואי-ודאות בכל החלטה.

---

## נספח יישום — החלטות קונקרטיות ל-Phase 1 (סביבה זו)

בחירות שאושרו מול המשתמש עבור ה-MVP הנוכחי (עוקפות ברירות-מחדל גנריות בגוף המסמך במקום הצורך):

- **שפה/מנוע:** Python + LangGraph.
- **אחסון state:** SQLite מאחורי שכבת-הפשטה (`Store`), כדי לאפשר החלפה ל-PostgreSQL בשלב מאוחר בלי לגעת בלוגיקה.
- **Model Gateway:** adapter דמה (mock) דטרמיניסטי כברירת-מחדל, כדי שבדיקות ירוצו offline; adapter אמיתי נטען דרך ה-Registry לפי env.
- **משימת-זרע:** *code-fix מאומת ע"י טסטים* — האות האובייקטיבי הכי חד-משמעי בסביבה נטולת-נתונים-חיצוניים
  (במקום ניטור-רכש/Shifts, שדורשים מערכת חיצונית). ראה `SEED_TASK.md`.
