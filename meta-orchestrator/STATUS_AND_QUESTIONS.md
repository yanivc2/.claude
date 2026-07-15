# מנהל-על לומד — סיכום מצב, החלטות, ושאלות פתוחות (להתייעצות)

> מסמך זה מסכם את כל מה שנבנה עד כה בסשן, מה קרה, אילו החלטות כבר נסגרו, ואילו שאלות
> פתוחות — כדי שתוכל להתייעץ. כתוב בעברית; מונחים טכניים ושמות-קוד באנגלית.
>
> **ענף:** `claude/meta-orchestrator-v2-kicadh` · **7 קומיטים דחופים** · **103/103 בדיקות offline עוברות**
> · **מיקום הקוד:** `meta-orchestrator/`

---

## 0. תמונת-מצב בשורה אחת

בנינו מערכת בשני חלקים: **(א) ה-MVP המקורי** (Phase 1 A–D של מנהל-על לומד, כולל adapter אמיתי מול Claude),
ו**(ב) מנגנון-הניסוי המבוקר** שהחליף את "הוכחת-הלמידה" הרפויה — **Pilot-0 harness** (מוסמך) ו**שכבת-קורפוס
ל-ingestion** (נבדקה מול fixture). **מה שחסר להוכחת-למידה אמיתית: קורפוס אמיתי עם hidden tests, ועליו
harness השוואתי A/B/C/D.** זה החסם, והוא דורש החלטה שלך (סעיף 6).

---

## ⭐ סשן הבא — התחל כאן

**חיבור ה-API אומת מקצה-לקצה ✅ (סשן 2026-07-15).** מפתח `META_ORCH_API_KEY` (שם לא-שמור; ראה למטה למה
לא `ANTHROPIC_API_KEY`) חובר לסביבת הענן (Default). מה שבוצע והושלם:
- אימות נוכחות (`key set`) + auth מול Haiku (`in/out=8/1`) בלי חשיפת הערך.
- **באג אמיתי נחשף ותוקן** (commit `352cc7e`): האדפטר שלח `adaptive thinking + effort` לכל מודל, ו-Haiku 4.5
  דוחה אותם ב-400. התיקון: `thinking_kwargs()` מודע-מודל. + טסט offline חדש. **103→104 טסטים עוברים.**
- הרצה אמיתית מקצה-לקצה: `status=completed passed=True model=claude-opus-4-8 cost=$0.0017`.

> ⚠️ **מה שהוכח = plumbing בלבד, לא למידה.** ההרצה אישרה שה-`AnthropicAdapter` מדבר עם Claude אמיתי
> (auth→run→verify→cost) ותפסה באג-API אמיתי. היא **לא** הוכיחה הכללת-מדיניות נלמדת — נבחר Opus על משימת
> seed טריוויאלית ועבר. **אימות-הלמידה האמיתי (§2 מול Haiku) עדיין לפנינו.**

> 💡 **למה `META_ORCH_API_KEY` ולא `ANTHROPIC_API_KEY`:** ב-Claude-Code-web ה-`ANTHROPIC_API_KEY` נחסם/מנותב
> דרך auth-החשבון (`ANTHROPIC_BASE_URL` → proxy), אז מפתח משתמש לא מגיע לתהליך. הפתרון (commit `c67491d`):
> שם env לא-שמור + `base_url='https://api.anthropic.com'` מפורש. ⚠️ המפתח `meta-orch-phase1` (~$5) שמור בשדה
> "visible to anyone using this environment" — **לבטל ב-Console כשמסיימים.**

**הרצף המוסכם (מכאן):**
1. **qualification הקורפוס** — הרצת ה-solver האמיתי כדי למלא `baseline_success` (כרגע `None`, "needs a solver run").
2. **§2 — אימות למידה אמיתי** עם Haiku (החלפת ה-DeterministicMockAgent הטאוטולוגי במודל אמיתי) — *לפני* 1B.
3. **1B** — learned מול D2 על ריפו אחד גדול.

**החלטה פתוחה (סעיף 6):** מקור-הקורפוס הסופי (PyBugHive כברירת-מחדל, ממתין לדוח-qualification).

---

## 🧊 Frozen Experimental Configuration (v2 §5)

> **למה זה כאן:** הקפאת הקונפיג לא מספיקה — צריך גם **לתעד** אותו. בלי snapshot מפורש, שיפור עתידי
> בלתי-ניתן-לייחוס: לא תדע אם התוצאה השתנתה בגלל הלמידה או בגלל שהמודל/קורפוס/verifier התחלפו. עדכן סעיף
> זה **בכל שינוי** של אחד מהשדות, והצמד אותו ל-commit hash.

| שדה | ערך נוכחי | מקור / הערה |
|---|---|---|
| **model snapshot** | `claude-opus-4-8`, `claude-haiku-4-5` | `config.py:52` (`default_candidate_models`). מזהי-alias — Haiku full-id `claude-haiku-4-5-20251001`; Opus 4.8 ללא dated-id (alias הוא ה-id). **לפני §2: להצמיד full-id.** |
| **thinking budget** | Opus: `adaptive` + `effort=high`. Haiku: `extended`, `budget_tokens=4000` | `adapters.py:86` `thinking_kwargs()`. Haiku = `min(4000, max_tokens//2)` עם `max_tokens=16000`. |
| **max_tokens** | `16000` | `adapters.py:145` (`AnthropicAdapter.__init__` default). |
| **temperature** | לא נשלח (N/A) | Opus 4.8 דוחה `temperature`/`top_p`/`top_k` ב-400. ההנחיה דרך prompt/effort בלבד. |
| **effort** | `high` | `adapters.py:145` default. |
| **routing disabled** | **לא** — routing פעיל (Decision-Engine + bandit בוחר בין המועמדים) | ל-§2 (הכללת-מדיניות) **צריך להחליט**: להקפיא למודל יחיד כדי לבודד למידה פרוצדורלית מבחירת-מודל. **TBD.** |
| **verifier version** | 6-gate composite (static/scope/no-shortcut/protected/public/hidden) — **ללא קבוע-גרסה מפורש** | `experiment/verifier.py`. **TBD: להוסיף `VERIFIER_VERSION` מפורש לפני השוואות A/B/C/D.** |
| **lesson schema version** | `v1` | `experiment/lesson.py:34` (`version: int = 1`). |
| **corpus version** | v2-corpus contract, `source=fixture` (סינתטי) | `corpus/`. **Real source = TBD** (PyBugHive, ממתין לדוח-qualification). |
| **benchmark version** | Pilot-0 seed: `off_by_one_sum` (משימה יחידה טריוויאלית) | `seed_task/`. **Real benchmark (train/val/locked-holdout) = TBD.** |
| **config snapshot** | תאריך `2026-07-15` · commit `352cc7e` (ה-HEAD בזמן הכתיבה) | לעדכן את שני אלה בכל שינוי לטבלה. |

**TBD מרוכז לפני §2:** full-model-ids · החלטת routing (הקפאה?) · `VERIFIER_VERSION` מפורש · מקור-קורפוס אמיתי · benchmark אמיתי עם holdout נעול.

---

## 1. מה נבנה — לפי שלבים

### חלק א' — ה-MVP המקורי (Milestones A–D + adapter אמיתי)
עמוד-שדרה עובד של מנהל-על לומד, task-agnostic:

| שלב | מה | קבצים עיקריים |
|---|---|---|
| **A** שלד+נתונים | טקסונומיה, שכבת-`Store` (SQLite, swappable ל-Postgres), Registry עם provenance, סכימות | `taxonomy, persistence/, registry/, config, bootstrap` |
| **B** עמוד-שדרה של למידה | `verify()` (מריץ pytest), טקסונומיית-כישלון, **bandit Beta-Binomial**, pipeline כתיבה-לזיכרון עם gate, Decision-Engine v1 (utility אחת) | `verification/, learning/, memory/, decision/` |
| **C** לולאת-סוכן | גרף **LangGraph**: classify→plan→select-model→execute→verify→(retry)→synthesize→independent-verify→post-mortem; Tool-Gateway עם מדרג-הרשאות | `orchestrator/, planner/, tools/, gateway/` |
| **D** בקרה | מצבי-אוטונומיה + circuit-breakers, tracing עם correlation-id, eval-harness | `autonomy/, observability/, evaluation/` |
| **adapter אמיתי** | `AnthropicAdapter` מול Claude Messages API (`claude-opus-4-8`/`claude-haiku-4-5`), client מוזרק לבדיקות offline | `gateway/adapters.py` |

### חלק ב' — מנגנון-הניסוי המבוקר (Pilot-0 + קורפוס)

| רכיב | מה זה מוכיח | קבצים |
|---|---|---|
| **Pilot-0 harness** | harness מבוקר: contract קפוא, sandbox+reset, **verifier מורכב (6 שערים)** שה-playbook לא נוגע בו, event-log append-only, ושני **mocks** (protocol נקי; adversarial נחסם לחלוטין) | `experiment/` |
| **שכבת-קורפוס (ingestion)** | source-agnostic: qualification (F2P/P2P), split hidden/public, **בידוד-פיזי** (hidden tests מחוץ ל-sandbox של הסוכן), sanitize-תיאור, patch-guard, מניפסט-holdout חתום, דוח-מועמדים | `corpus/` |

**הערה חשובה:** שכבת-הקורפוס נבדקה מול `FixtureCorpusSource` **סינתטי** — **לא נתונים אמיתיים**.
המקור האמיתי (PyBugHive) מחובר כ-seam בלבד ולא רץ עדיין.

---

## 2. המסע המתודולוגי — למה השתנתה ההגדרה של "הוכחה" (החלק הכי חשוב להתייעצות)

זה לב-העניין. עברנו שלושה גלגולים, וכל אחד תיקן חור מתודולוגי אמיתי:

1. **v1 (Milestone D המקורי):** "הוכחנו שה-playbook משתפר בין ריצות" — ה-eval שלי הראה bandit שמתקן
   prior מוטעה, confidence שעולה, rounds שיורד.
   **הבעיה שזיהינו:** זו **לא הוכחת-למידה**. הרצתי את אותו קורפוס שוב ושוב (train=test, דליפה),
   וה"למידה" הייתה בעצם *בחירת-מודל*, לא מדיניות-פרוצדורלית שמכלילה למופעים חדשים.

2. **v2 (ניסוי מבוקר):** הגדרה מחדש — "**מדיניות פרוצדורלית שנלמדה משפרת ביצועים על מופעים חדשים
   שלא-נראו, מאותה התפלגות, ב-A/B מבוקר**". נוספו: condition D (playbook **סטטי כתוב-ביד** כ-control),
   held-out נעול, hidden tests, harness מבוקר במקום Claude-Code-כקופסה-שחורה, חוזה קפוא, event-sourcing.

3. **מפרט-קורפוס:** החלק הכי error-prone. הגדיר בדיוק איך בונים קורפוס בלי לזייף את הניסוי בשקט
   (reference דלוף, hidden test נגיש דרך git, תיאור שמדליף פתרון). זה מה שבנינו עכשיו.

**שתי נקודות-עומק שהעליתי ושכדאי להביא להתייעצות:**
- **התוצאה הכנה הסבירה-ביותר היא C≈D.** לבאגים-קטנים הידע-הפרוצדורלי קטן, סופי, וניתן-לכתיבה-ביד
  (בדיוק מה ש-D תופס). זו **תוצאה לגיטימית** (חוסכת בניית מערכת), אבל שווה לשקול אם משפחת-משימות עם
  ידע-פרוצדורלי *גדול ולא-בַּר-מִניָּה* היא זירת-ההוכחה הנכונה יותר ל"למידה שווה משהו".
- **`generator ≠ solver`:** אם אני (מודל Claude) ממציא את הבאג+הטסטים+הפתרון, והסוכן-הנמדד הוא מודל-Claude,
  יש confound של prior-משותף. לכן בחרנו במקור אמיתי (בני-אדם כתבו את הבאגים).

---

## 3. מה עובד עכשיו (מצב-בדיקות)

- **103/103 בדיקות offline עוברות** (~2 דקות; חלקן מריצות pytest אמיתי ב-subprocess).
- הכל **offline ודטרמיניסטי** — לא דורש מפתח-API או רשת.
- **דמואים להרצה:**
  - `examples/agent_run.py` — לולאת-הסוכן המלאה (mock).
  - `examples/eval_run.py` — ה-eval הישן (v1; מוכיח bandit, לא למידה-אמיתית).
  - `examples/pilot0_demo.py` — הסמכת-harness (protocol נקי, adversary נחסם).
  - `examples/corpus_demo.py` — דוח-מועמדים + הדגמת בידוד §6.
  - `examples/real_run.py` — ריצה מול Claude אמיתי (דורש `ANTHROPIC_API_KEY`).

**פלט `corpus_demo.py`:**
```
§3 report: total=4 admitted=2   (vague + non-compiling נדחו)
§6 isolation: agent zone hidden_tests={}   (hidden probe present? False)
             sanitized: 'sum_to(n) should return the sum of 1..n inclusive but is off by one.'
evaluator: buggy→FAIL(hidden) · correct→PASS · hardcode-15→FAIL(public)
```

---

## 4. החלטות שכבר נסגרו

| נושא | ההחלטה | למה |
|---|---|---|
| שפה/מנוע | Python + LangGraph | אקוסיסטם בוגר |
| אחסון | SQLite מאחורי `Store`/ports, Postgres swappable | אפס-התקנה, reproducible |
| Model Gateway | mock דטרמיניסטי כברירת-מחדל; adapter אמיתי דרך env | בדיקות offline |
| משימת-זרע (MVP) | code-fix מאומת ע"י טסטים | אות אובייקטיבי נקי |
| הגדרת-הוכחה | ניסוי מבוקר A/B/C/D על held-out (v2) | מונע הוכחה-מזויפת |
| מדיניות פיצול | אפשרות 1: hidden=F2P אמפירי, public=P2P | מונע חשיפת טסט-הבאג |
| מקור-קורפוס (עקרון) | אפשרות א' — באגים אמיתיים (generator≠solver) | הכי חזק מתודולוגית |

---

## 5. סיכונים ומגבלות ידועות (ביקורת-עצמית)

1. **עוצמה סטטיסטית:** 10 holdout × 2–3 reps הוא מדגם זעיר; רווח-סמך על שיעור בינארי ב-n=10 הוא ~±30
   נק'. אפקט של "≥10 נק'" בקושי ניתן להבחנה מרעש. **המלצה:** עיצוב מזווג + מבחן McNemar (עוצמה גבוהה
   יותר בלי עוד משימות), ולהצהיר ש-Phase-1-א' הוא פיילוט directional.
2. **headroom:** מודל-חזית על באגים קלים כבר טוב מאוד → אולי אין מקום שלקח יזיז את המחט (תוצאת-אפס
   שלא אומרת שהלמידה נכשלה). לכן בחירת מודל-הבסיס נעשית **אחרי calibration** (Pilot-1), לא ידנית.
3. **contamination:** קורפוסים ציבוריים אולי היו בנתוני-האימון → מנפח baseline / מסתיר learning-gain.
   המדד המרכזי הוא **behavioral (עבר hidden test)**, לא patch-similarity.
4. **מגבלת-fixture:** ב-`fx-even-operator` כיסוי-ה-hidden חלש → hardcode יכול לעבור. זו **בעיית
   איכות-קורפוס** (F2P חייב להיות חזק), לא באג-harness — תופיע בדוח-האיכות של קורפוס אמיתי.
5. **PyBugHive בסביבה הזו:** לא ידוע אם ניתן לאחזר ולשחזר per-bug (setup+deps+הרצת-טסטים) כאן. §3 דורש
   למדוד `reproducible now` לפני שבוחרים — עוד לא נמדד.

---

## 6. השאלות הפתוחות — עם המלצות והשלכות (הלב של ההתייעצות)

### שאלה 1 (חוסמת): מקור-הקורפוס האמיתי
- **(א) שאנסה לאחזר PyBugHive** ולהפיק דוח-qualification אמיתי. *יתרון:* מקור מאומת, מוכן.
  *סיכון:* שחזור per-bug בסביבה הזו לא ידוע-שעובד; עלול לדרוש עבודת-triage.
- **(ב) repo פרטי/מקומי שלך** → אבנה `GitHistorySource`. *יתרון:* הכי חזק נגד contamination (§9).
  *דרוש:* שתפנה repo Python עם היסטוריית-באגים ממוקדת + טסטים.
- **(ג) קורפוס סינתטי הגון** (אני בונה, מתעד מגבלת generator≈solver). *יתרון:* מהיר. *חיסרון:* confound מוכר.
- **המלצתי:** (ב) אם יש לך repo מתאים; אחרת (א) עם ציפייה שנמדוד `reproducible now` לפני התחייבות.

### שאלה 2 (אסטרטגית): האם באגים-קטנים היא זירת-ההוכחה הנכונה?
אם המטרה היא להוכיח ש-**learned > static**, באגים-קטנים עלולים לתת C≈D (ידע פרוצדורלי קטן). האם לשקול
משפחת-משימות עם ידע-פרוצדורלי גדול יותר (אבחון-כשלים מורכב, דפוסי-הקשר)? *טרייד-אוף:* קשה יותר לבנות
קורפוס עם hidden tests. **שווה התייעצות** — זו בחירה שקובעת אם הניסוי בכלל יכול להראות יתרון-למידה.

### שאלה 3 (רצף-בנייה): מה לבנות אחר-כך?
- **(א) harness ה-A/B/C/D + סטטיסטיקה מזווגת** — **בלתי-תלוי במקור-הקורפוס**, אפשר לבנות מול fixture עכשיו.
- **(ב) לעצור לביקורת-קוד** של Pilot-0 + שכבת-הקורפוס לפני שממשיכים.
- **המלצתי:** אפשר (א) במקביל לבחירת-הקורפוס (שאלה 1), כי הוא לא תלוי בה.

### שאלה 4 (תפעולי): אחסון
המפרט הזכיר PostgreSQL; בחרנו SQLite-עם-ports. אם תרצה את קריטריון "crash/resume" האמיתי של המעבר
ל-Phase 2 — אממש Store ל-Postgres. אחרת SQLite מספיק ל-Phase 1. *ברירת-מחדל: SQLite.*

---

## 7. מה שבמכוון לא נבנה (גבול-scope שנשמר)

multi-agent · multi-provider ensemble · exploration (ε) · זיכרון-חיצוני מורכב · commit-miner מלא ·
`GitHistorySource`/`BugsInPySource` חיים · harness A/B/C/D · קידום-lessons בפועל (Pilot-0 בכוונה בלי-קידום).
כולם Phase 2+ או תלויי-החלטה.

---

## 8. איך לאמת בעצמך

```bash
cd meta-orchestrator
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q                 # 103 passed
.venv/bin/python examples/corpus_demo.py      # ingestion + isolation
.venv/bin/python examples/pilot0_demo.py      # harness qualification
```

**מסמכי-מקור בריפו:** `SPEC.md` (v2 מלא) · `BUILD-CHECKLIST.md` · `SEED_TASK.md` ·
`experiment/README.md` (מיפוי §→מודול לניסוי ולקורפוס).
