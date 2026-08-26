# INDEX — מפת פיצ'רים, כפתורים והשפעות (AP Control)

**מטרת הקובץ:** לפני **כל** שינוי — קראו את החלק הרלוונטי כאן. לכל פיצ'ר/כפתור מתועד: מה הוא עושה,
לאן הוא מחווט (route → service → view), למה הוא מקושר, **ומה קורה אם מוחקים / משנים / מזיזים אותו.**
המטרה: שאף שינוי לא ישבור משהו אחר בשקט.

> **פרוטוקול שינוי (חובה):**
> 1. מצא את הפיצ'ר בטבלה המתאימה למטה → קרא את עמודת "אם מוחקים/משנים/מזיזים".
> 2. עבור על **"אינווריאנטים נושאי-עומס"** (הפרק הבא) — אלה הדברים שנשברים בשקט.
> 3. הרץ `npm test` **וגם** `TEST_PG=1 npm test` (שני הדיאלקטים) + `node scripts/smoke.mjs` לפני דחיפה.
> 4. שינוי סכימה? עדכן 3 מקומות (ראה למטה) והזכר לבעלים ללחוץ **הגדרות → "עדכן מסד נתונים"**.
> 5. עדכן את הקובץ הזה **ואת `CLAUDE.md`** כשמוסיפים/משנים פיצ'ר.

---

## 🔴 אינווריאנטים נושאי-עומס (נשברים בשקט — קרא לפני הכל)

| # | האינווריאנט | איפה | אם שוברים אותו |
|---|---|---|---|
| 1 | **סכימה חיה ב-3 מקומות** | `src/db/schema.sql` (SQLite חדש), `src/db/migrate.js` (SQLite קיים), `src/db/schema.pg.sql` (Postgres, כולל `ALTER … ADD COLUMN IF NOT EXISTS` בתחתית) | עמודה/טבלה חדשה שלא נוספה לכל 3 → קורס בפרוד או ב-CI; שדה יוצא `undefined` בתצוגה. |
| 2 | **`RETURNING id` אוטומטי ב-PG** | `src/db/adapter.js` — כל `x.run('INSERT…')` מוסיף `RETURNING id`. | טבלה שה-PK שלה **אינו `id`** (למשל `app_settings.key`, `invoice_ocr.invoice_id`) → ה-INSERT קורס ב-Postgres. **פתרון:** הוסף `RETURNING <pk>` מפורש ל-SQL. |
| 3 | **`x.one` מחזיר `undefined`** (לא `null`) כשאין שורה | `adapter.js` | לבדוק עם `!row`, לא `=== null`. |
| 4 | **כסף = אגורות שלמות** (₪1 = 100) | `lib/money.js` | חישוב בשקלים/צף → סטייה ב-R5 (סכום צ׳ק = Σ שורות). תמיד `toAgorot`/`fromAgorot`/`formatIls`. |
| 5 | **חומת הרשאות (firewall)** | `middleware/requireOwner.js#enforcePageScope` + `lib/permissions.js` (`NAV_PAGES`,`NAV_ALLOW`,`OPEN_PATHS`) | תפקיד מוגבל (קופאי→`/zclosing` בלבד) יגיע לכל דף אם משנים לא נכון. נתיב חדש שצריך גישה → הוסף ל-`NAV_ALLOW`/`OPEN_PATHS`. |
| 6 | **`footer.ejs` — enhancers גלובליים** | `partials/footer.ejs` | בורר-תאריך מחליף כל `input[type=date]`; קומבובוקס מחליף `<select class="js-combo">`; **מקפל רובריקות** — כל `.card` עם `<h2>` ישיר הופך למתקפל (אקורדיון: פתיחת אחד סוגר אחרים, מצב נשמר ב-localStorage). דילוגים: `<details>`, `.no-collapse`, כרטיס עם `[required]`. וגם `<details data-accordion="grp">` (אקורדיון native). שינוי שם משפיע על **כל** הדפים. |
| 7 | **`BUILD_VERSION`** ב-`src/app.js` | מוצג ב-footer של דף login | לא מקדמים כל deploy → אי אפשר לאמת שהעלייה חיה. סשנים מקבילים מתנגשים על אותו `·NN` — קח מספר חדש אחרי rebase. |
| 8 | **DB חי = Postgres (Neon); אין apply-schema אוטומטי** | `api/index.js` `connectDb()` | אחרי שינוי סכימה הבעלים **חייב** ללחוץ הגדרות → "עדכן מסד נתונים". אין לי גישה ל-DB החי — deploy לא נוגע בשורות קיימות. |
| 9 | **workflow דחיפה** | `apnew/main` = מה ש-Vercel מפרסם | `git push apnew ap-control-split:main` + mirror `git push origin ap-control-split`. `fetch apnew main && rebase` לפני כל דחיפה. אף פעם לא לדרוס commit של סשן אחר. |
| 10 | **סכימה נבחרת מפורשות ב-SELECT** | הרבה services בוחרים רשימת עמודות מפורשת (`getUser`/`listUsers`) | עמודה חדשה שלא נוספה ל-SELECT → `undefined` בתצוגה למרות שהיא במסד. |
| 11 | **הקשר "חנות פעילה" + הרשאה פר-חנות** | `middleware/currentUser.js` (קובע `req.activeStoreId`, `req.scope.storeIds`, `res.locals.activeStore/availableStores`), `lib/scope.js` (`authorizedStoreIds`/`availableStoresFor`/`setUserStores`), `routes/context.js` (`POST /context/store`, cookie `ap_store`), טבלת `user_stores`. | הבורר בבאנר (`header.ejs`) חייב את `/context` ב-`OPEN_PATHS` אחרת תפקיד מוגבל חסום. `authorizedStoreIds`: אין grants → כל חנויות החברות המורשות (תאימות לאחור). `authorizedCompanyIds` מאחד גם חברות-דרך-חנויות. טפסי יצירה (חשבונית/סגירה) ננעלים ל-`activeStore`. |

---

## 🧭 Chrome גלובלי (מופיע בכל דף)

**קובץ:** `partials/header.ejs` (nav + theme), `partials/footer.ejs` (enhancers + מחוות מובייל), `partials/_ownerDialogs.ejs` (חלונות בעלים).

| רכיב | מה עושה / מחווט | אם מוחקים/משנים/מזיזים |
|---|---|---|
| **תפריט ניווט (☰ / סרגל צד)** | לינקים לפי `nav('nav_*')` = `canView` (`lib/permissions.js`). כל לינק מוגן גם ב-mount (`app.js`) ב-`requirePageAccess`. | מחיקת לינק = הדף עדיין נגיש ב-URL ישיר לבעלים. הוספת לינק בלי `requirePageAccess` במאונט = פרצת גישה. |
| **מתג מצב בהיר/כהה** (🌙/☀️) | `apToggleTheme()` שם `data-theme=light` על `<html>` + שומר `ap-theme` ב-localStorage. סקריפט ב-`<head>` מיישם לפני צביעה. פלטה: `nocturne.css` תחת `:root[data-theme="light"]`. | הסרת סקריפט ה-`<head>` → הבזק כהה→בהיר בטעינה. שינוי שם המפתח `ap-theme` → מאבד העדפות שמורות. |
| **לינק "צילום חשבוניות"** | מסומן 🔒 "נעול" כש-`scanEnabled=false` (מגיע מ-`res.locals.scanEnabled` ב-`app.js`). | ראה "נעילת צילום" למטה — התלוי ב-`app_settings.scan_enabled`. |
| **בורר תאריך (footer)** | מחליף `input[type=date]` → תצוגה DD/MM/YY, הקלדה במחשב (`parseTyped`). שומר hidden ISO בשם המקורי. | שינוי → משפיע על **כל** שדות התאריך. `data-dp-mode=week/month` נשארים picker-only. |
| **קומבובוקס (footer)** | מחליף `<select class="js-combo">` בשדה חיפוש; ה-select נשאר הערך הנשלח. | הסרת המחלקה `js-combo` מהשדה מחזירה select רגיל (לא שובר). שינוי הלוגיקה משפיע על שדה הספק בחשבוניות. |
| **חלונות בעלים** (`_ownerDialogs.ejs`) | כפתור `apOpen('dlg-X')` + `<dialog id="dlg-X">` **חייבים לנסוע יחד** (מבחן `orgs-permissions.test.js` אוכף). | כפתור בלי הדיאלוג = כפתור מת (showModal על null). מחיקת דיאלוג → הסר גם את הכפתור + עדכן את מערך `ACTIONS` במבחן. |
| **באנר "חנות פעילה"** (`header.ejs`, ראשון ב-`<main>`) | מציג `activeStore` (או "כל החנויות"); בורר `<select onchange=submit>` + כפתור מחווט ל-`POST /context/store` (cookie `ap_store`). CSS `.store-banner` ב-`nocturne.css`. נעילה אוטומטית כשיש חנות זמינה אחת. | מוצג בכל דף כשיש `availableStores`. הסרת ה-cookie/route → אין הקשר. תלוי ב-`res.locals.availableStores/activeStore` מ-`currentUser`. |

---

## 🏠 לוח בקרה — `routes/index.js` (`/`), `views/dashboard.ejs`

| כפתור/פיצ'ר | route | wiring | מה עושה / מקושר | אם מוחקים/משנים |
|---|---|---|---|---|
| חיפוש (`q`) + חנות/חברה | `GET /` | `invoiceLookup` (`reports.js`), `lookupChecks` (`payments.js`), `searchSuppliers` | **רב-מונחים**: `lib/search.js` (`parseSearchTerms`/`anyTermLike`) — פיצול רווח/פסיק/;/שורה, OR. תוצאות: חשבוניות/צ׳קים/ספקים. Enter שולח (טופס רגיל). | שינוי `lib/search.js` משפיע גם על רשימת החשבוניות. הסרת `q` = אין חיפוש בלוח. |
| "רק שלא שולמו" | `GET /?unpaid=1` | `invoiceLookup({unpaidOnly})` → `AND i.status<>'paid'` | מסנן תוצאות החשבוניות לפתוחות. | תלוי בסטטוסי החשבונית — ראה "סטטוס חשבונית". |
| קוביות (ספקים ממתינים, מוחזקות, צ׳קים בחוץ, מזומן לא-משויך, הפקדות, פערי Z) | `GET /` | `dashboardStats`, `outstandingChecks`, `unmatchedCashExpenses`, `listDeposits`, `zSequenceStatus` | קריאה-בלבד; לינקים לדפי המקור. "תשלום במזומן ללא התאמה" מ**אחד** את שתי טבלאות ההוצאות (`z_expenses` מדוח-Z **+** `z_closing_expenses` מסגירת-Z) דרך UNION; שדה `source` קובע אם הלינק ל-`/reports/zreports/:id` או `/zclosing/:id`. | מחיקת קובייה = ויזואלי בלבד. אם משנים את שמות השדות (`source`/`ref_id`) — לעדכן גם `dashboard.ejs`. |
| אישורים (`/approvals`) | `GET /approvals`, `POST /approvals/:id/approve|reject` | `services/changeRequests.js` | עריכות של לא-בעלים ממתינות לאישור בעלים → מיושמות ב-approve. | מחיקה = לא-בעלים לא יכולים לבקש שינויים. |
| יומן (`/audit`) | `GET /audit`, `POST /audit/events…` | `services/calendar.js`, `services/audit.js` | לוח שנה + לוג פעולות + תזכורות פוש. | קריאה-בלבד ברובו. |

---

## 🧾 חשבוניות — `routes/invoices.js`, `services/invoices.js`, `views/invoices/*`

**מוגן ב-`requirePageAccess('nav_invoices')`.**

| כפתור/פיצ'ר | route | wiring | מה עושה / מקושר | אם מוחקים/משנים/מזיזים |
|---|---|---|---|---|
| רשימה + סינון (סטטוס/ספק/חנות/תאריך/`q`) | `GET /invoices` | `listInvoices` | טאבים כולל **`unpaid`** וירטואלי (`status<>'paid'`). `q` רב-מונחי. | שינוי מיפוי הסטטוס → משפיע על הטאבים. `unpaid` תלוי בערך `'paid'`. |
| חשבונית חדשה + תשלום מוטמע | `GET /invoices/new`, `POST /invoices` | `createInvoice` (+יצירת תשלום) | R2 (כפילות הקצאה=חסימה קשה), R3 (מס מעל סף בלי הקצאה→on_hold). שדה ספק=קומבובוקס. שדה "סכום כולל מע"מ" מסגרת צהובה (`input-hl-yellow`). מספר הקצאה **≥6 ספרות** (`normalizeAllocation` `/^\d{6,}$/`). | שינוי `normalizeAllocation` = משנה ולידציה בכל 4 שדות ההקצאה (new/edit/show/OCR-apply). הסרת השדה הצהוב = ויזואלי. |
| "צרף חשבונית פתוחה" (📎) | `GET /invoices/new?…&pick=ids` | `listPayable` → dialog | בוחר חשבוניות פתוחות של **ספק אחד** → ניווט עם `pick` → מסמן מראש בקטע התשלום המרוכז. | תלוי ב-`listPayable` (status recorded/approved) ובקטע pay-batch. |
| תשלום מרוכז | `POST /invoices/pay-batch` | `createPayment` (רב-חשבוניות, זיכוי=שלילי, net=Σ) | `invoice_ids[]` (מפתחות חוזרים!) + אמצעי תשלום → תשלום אחד. | תלוי ב-R1/R5. שינוי encoding (מערך→מחרוזת) שובר. |
| דף חשבונית + מספר חשבונית | `GET /invoices/:id` | `getInvoiceDetail` (`SELECT i.*`) | מציג מספר חשבונית + שורות (אם מסריקה) + תמונה/OCR. | הסתרת מספר החשבונית הייתה בעבר — הוחזרה. |
| תפריט **אפשרויות** (גם אחרי תשלום) | לינקים | `can('edit_invoice')` / `can('approve_payment')` | ✏️ ערוך חשבונית (מוסתר כש-`status==='paid'`) · 💳 ערוך אמצעי תשלום (אם יש תשלום) · ➕ לאותו ספק (`?supplier=&store=`). | התפריט מוצג גם לחשבונית ששולמה (בשביל תשלום/הוספה). עריכת **נתוני** חשבונית ששולמה חסומה — `GET /:id/edit` מפנה (303) חזרה; מתקנים דרך "ערוך אמצעי תשלום". |
| ערוך חשבונית | `GET/POST /invoices/:id/edit` | `updateInvoice` (`requirePermission('edit_invoice')`) | עריכת ספק/מספר/סכום/הקצאה; חוסם חשבונית ששולמה. | R2 נבדק מחדש. |
| תשלום/אישור (תפריט) | `POST /invoices/:id/{approve,request-payment,release,hold,allocation}` | `services/invoices.js` | R3 (הקצאה), R1/R5 (תשלום), החזקה (on_hold) + סיבה + תזכורת פוש. | שינוי סטטוסים משפיע על התשלום ועל ה-firewall. |
| תמונה/OCR | `POST /invoices/:id/{image,ocr,ocr/apply,ocr/delete,image/delete}` | `services/ocr.js`, `lib/storage.js` | העלאת צילום (שחור-לבן), OCR כתמיכת החלטה בלבד (לא דורס ערכים). | `image_path`/`invoice_ocr` (PK=`invoice_id`, ON DELETE CASCADE). |

**סטטוס חשבונית:** `recorded → approved_for_payment → paid`, או `on_hold`. `unpaid` = כל מה ש-`<>'paid'`. משפיע על: firewall, pay-batch, "לא שולמו", `listPayable`.

---

## 💳 תשלומים/צ׳קים — `routes/payments.js`, `services/payments.js`, `views/payments/*`

**מוגן ב-`requirePageAccess('nav_payments')`.**

| כפתור/פיצ'ר | route | wiring | מה עושה / מקושר | אם מוחקים/משנים/מזיזים |
|---|---|---|---|---|
| רשימה + סינון-עמודות | `GET /payments` | `listPayments` | סינון client-side בשורת ה-`.filter-row`. | ויזואלי. |
| תשלום חדש | `GET /payments/new`, `POST /payments` | `createPayment` | R1 (ספק+חשבונית מאושרים), R5 (סכום=Σ שורות), מזהה לפי אמצעי (צ׳ק=מספר צ׳ק וכו'), תקרת מזומן. **בודק מראש כפילות מספר צ׳ק פעיל** → הודעה בעברית. | R1/R5 קריטיים. שינוי המזהים משפיע על `getCheckPrintData`. |
| דף תשלום + סטטוס | `GET /payments/:id` | `getPaymentDetail` | פירעון/ביטול דרך תגית הסטטוס. | — |
| **ערוך אמצעי תשלום** | `GET/POST /payments/:id/edit` | `updatePayment` (`requirePermission('approve_payment')`) | עריכת אמצעי/מזהה/תאריך. **ורק לצ׳ק "הונפק" ולא מותאם-בנק** — re-target של החשבוניות: הוספת זיכוי → הסכום=net מחדש (R5 נשמר, לא נערך ידנית). | מסך `payments/edit.ejs`. re-target משנה סטטוסי חשבוניות (paid↔recorded). חסום ל-cleared/voided/matched. |
| נפרע / החזר / בטל | `POST /payments/:id/{clear,unclear,void}` | `markCleared`,`markIssued`,`voidPayment` | ביטול → **משחרר את מספר הצ׳ק** (האינדקס `ux_payments_account_check` מחריג `status='voided'`). | שינוי האינדקס (הסרת החרגת voided) מחזיר את הבאג "אי אפשר להנפיק שוב מספר צ׳ק שבוטל". |
| הדפסת צ׳ק | `GET /payments/:id/print` | `getCheckPrintData`, `views/payments/print.ejs` | פריסת Standard-501; פעיל תחת `config.checkPrinting.approved`. | דורש MICR font + אישור בנק. |
| התאמה אוטומטית | `POST /payments/auto-reconcile` | `services/reconciliation.js` | — | ראה התאמת בנק. |

**קריטי:** האינדקס `ux_payments_account_check` = `(bank_account_id, check_number) WHERE check_number IS NOT NULL AND status<>'voided'` — קיים ב-schema.sql / schema.pg.sql / migrate.js (`migrateCheckNumberReuse`). שינוי בו = שנה בכל שלושתם.

---

## 📊 דוחות Z — `routes/reports.js`, `services/zreports.js`, `views/reports/*`

**`/reports` — הגישה מוגנת per-sub-page בתוך ה-router.**

| כפתור/פיצ'ר | route | wiring | מה עושה / מקושר | אם מוחקים/משנים |
|---|---|---|---|---|
| דוחות Z (רשימה/הוספה/עריכה) | `GET/POST /reports/zreports[/:id]` | `_zform.ejs` (טופס משותף) | הוצאות מזומן עם **kind** (manual/salary/advance/invoice→`description_type`) המקשר עובד/חשבונית. | `z_expenses.invoice_id`/`employee_id` (nullable). מחיקת Z → cascade ל-`z_expenses`. |
| הוצאות (bulk/single/מחיקה) | `POST /reports/zreports/:id/expenses[-bulk]`, `POST /reports/zexpenses/:id/delete` | `zreports.js` | — | — |
| הפקדה / כרטיסי אשראי / חשבון-מגירה | `POST /reports/zreports/:id/{deposit,creditcards,verify-bills}` | — | התאמת מזומן/אשראי; חוסר/יתרה. | `deposits.z_report_id` (nullable). |
| רווחיות / צ׳קים בחוץ / lookup (+CSV) | `GET /reports/{profitability,outstanding,lookup}[.csv]` | `services/reports.js` | קריאה-בלבד; `lookup` משתמש ב-`invoiceLookup` (רב-מונחי). | — |

---

## 🔒 סגירת Z (קופה) — `routes/zclosing.js`, `services/zclosing.js`, `views/zclosing/*`

**מוגן ב-`requirePageAccess('nav_zclosing')`. קופאי נעול לדף הזה ע"י ה-firewall.**

| כפתור/פיצ'ר | route | wiring | מה עושה / מקושר | אם מוחקים/משנים |
|---|---|---|---|---|
| הזנת סגירה + ספירת מזומן | `GET/POST /zclosing` | `createZClosing` (`computeClosing` — כל הסכומים בשרת) | בחירת חנות ננעלת אם יש חנות מורשית אחת; אחרת dropdown scoped. חוסר>₪20 → פוש. | חישוב תמיד בשרת (לא סומכים על הדפדפן). |
| **איזון קופות** | אותו POST (`reg_*[]`) | `normalizeRegisters` → `z_closings.registers` (JSON) | ספירת מזומן per-קופה לפני ה-Z; עצמאי מטבלת המגירה. | עמודה `registers` ב-3 מקומות. `edit.ejs` טוען מראש מה-JSON. |
| הוצאות מזומן (kinds) | אותו POST (`expense_*[]`) | `insertExpenses` → `z_closing_expenses` | ידני/שכר/מפרעה/חשבונית; מקשר עובד/חשבונית. רובריקה משותפת בדף חשבוניות (`_cashExpenses.ejs`). כל שורה ב-`_cashExpenses` מקשרת ל-`/zclosing/:closing_id` **רק לבעלים** (הדף `requireOwner`); לאחרים טקסט בלבד. | `z_closing_expenses.invoice_id` (nullable, **לא** cascade — ה-clean-start מנתק אותו). הלינק תלוי ב-`closing_id` שמגיע מ-`recentClosingExpenses`. |
| עריכה/מחיקה | `GET /zclosing/:id`, `POST /zclosing/:id[/delete]` (owner) | `updateZClosing`,`deleteZClosing` | — | — |
| "הוצאות מזומן אחרונות" / "סגירות אחרונות" (מתקפלים) | `views/zclosing/index.ejs` (client-only) | `<details class="collapse-card" data-accordion="recent-z">` + סקריפט accordion inline | שני קלפים מתקפלים, סגורים כברירת מחדל; פתיחת אחד סוגרת את השני (קבוצת `recent-z`). תצוגה בלבד — לא נשמר. | הסקריפט תלוי ב-`data-accordion` על שני ה-`<details>`; להשאיר אותם באותה קבוצה. `.collapse-card` מוגדר ב-`nocturne.css`. |

---

## 🏢 ספקים — `routes/suppliers.js`, `services/suppliers.js`, `views/suppliers/*`

| כפתור/פיצ'ר | route | wiring | מה עושה / מקושר | אם מוחקים/משנים |
|---|---|---|---|---|
| רשימה / אנשי קשר / חדש / עריכה | `GET /suppliers[/contacts,/new,/:id/edit]`, `POST …` | `createSupplier`,`updateSupplier` | סטטוס pending/approved/blocked; שיוך רב-חנותי (`supplier_stores`, `_storepick.ejs`). | חשבוניות/תשלומים תלויים ב-`supplier.status='approved'` (R1). |
| אישור/חסימה/מחיקה | `POST /suppliers/:id/{approve,block,delete}` | — | אישור = מאפשר תשלום. | חסימה חוסמת תשלום. |
| "סקיל" הספק | `POST /suppliers/:id/scan-hints` | `services/supplierProfile.js` (`suppliers.scan_profile`) | פרופיל מבנה החשבונית לצילום. | אזור סשן מקביל — תאם. |

---

## 🏦 התאמת בנק — `routes/reconciliation.js`, `services/reconciliation.js`

**מוגן ב-`requirePageAccess('nav_reconciliation')`.** ייבוא CSV/XLSX (Hapoalim, `lib/bankCsv.js`), התאמת תנועות לתשלומים (`bank_transactions.matched_payment_id`) והפקדות (bag=reference). מחיקת תשלום מנתקת התאמות (clean-start עושה זאת).

---

## 👥 עובדים — `routes/employees.js` · 🧾 הפקדות — `services/deposits.js`
עובדים: `GET/POST /employees`, מחיקה. מפרעות/שכר מ-Z ניזונים לספר-מעקב. הפקדות ("הצהרות הפקדה") מותאמות לבנק לפי bag.

---

## ⚙️ הגדרות — `routes/settings.js`, `views/settings/*`, `partials/_ownerDialogs.ejs`

| כפתור/פעולה | route | wiring | מה עושה / מקושר | אם מוחקים/משנים/מזיזים |
|---|---|---|---|---|
| חברות/חנויות/חשבונות | `POST /settings/{companies,stores,accounts}[/…]` | `services/orgs.js` | הקמה + `deleteStore`. | חשבוניות/Z תלויים בחנות+חשבון בנק. |
| משתמשים + הרשאות + מטריצת חברות | `POST /settings/users[/:id/…]` | `services/users.js`, `_permpicker.ejs`, `lib/scope.js` | הרשאות ויזואליות (`PERMISSIONS`), presets (`ROLE_PRESETS`), הפרדת חברות. | הרשאות משפיעות על ה-firewall ועל הניווט. |
| מטריצת הרשאות חנויות (פר-חנות) | `POST /settings/users/:id/stores` (owner) | `storeGrantMatrix`/`setUserStores` (`lib/scope.js`), עמודות מ-`listStructure` (חברה→חנויות) | סימון חנויות → `user_stores`; ריק = כל חנויות החברות המורשות. קובע את `availableStores` (בורר החנות הפעילה). | מוגן ב-`router.use('/users', requireOwner)`. תלוי ב-`companies` (nested stores) ו-`storeGrants` מה-render. |
| הזמנה / קישור הגדרה-עצמית | `POST /settings/users/:id/{invite,invite-link}` | `services/passwordReset.js` (`createInviteLink`,`completeInvite`) | וואטסאפ / קישור `/invite/:token`; מדיניות סיסמה ≥6, אות גדולה+קטנה+ספרה, אלפאנומרי. | טוקנים ב-`password_resets`. מדיניות ב-`lib/auth.js`. |
| **עדכון מסד נתונים** (`dlg-db`) | `POST /settings/db-upgrade` | `upgradeSchema` (re-apply `schema.pg.sql`) | הרצה אחרי כל שינוי סכימה. בטוח, לא מוחק. | חובה אחרי עמודה/טבלה חדשה. |
| גיבוי מלא (`dlg-backup`) | `GET /settings/backup` | `exportAll` (`backup.js`) | JSON snapshot של כל הטבלאות. | — |
| שחזור (`dlg-restore`) | `POST /settings/restore` | `restoreAll` | מחליף הכל. בלתי הפיך. מוגן בסיסמת בעלים. | — |
| **התחלה נקייה** (`dlg-clean`) | `POST /settings/clean-start` | `cleanStartInvoicesPaymentsZ` | מוחק חשבוניות/תשלומים/דוחות-Z/טיוטות; **שומר** z_closings/ספקים/קטלוג/עובדים/הפקדות. מנתק FK מתים קודם, מוחק child→parent. מוגן בסיסמה. | בלתי הפיך. שינוי הסדר = הפרת FK ב-PG. |
| **איפוס** (`dlg-reset`) | `POST /settings/reset-data` | `resetTransactionalData` | מוחק נתוני עבודה, שומר הקמה. בלתי הפיך. | — |
| **צילום חשבוניות — נעול/פעיל** | `POST /settings/scan-toggle` | `setScanEnabled` (`appSettings.js`) | מפעיל/נועל את הצילום (`app_settings.scan_enabled`). | ראה "נעילת צילום". |
| בדיקת אחסון | `POST /settings/storage-test` | `lib/storage.js` | כתיבה/קריאה/מחיקה של קובץ זעיר. | — |
| ~~טעינת קטלוג-על~~ | `POST /settings/catalog-import[/…]` | `masterCatalog.js` | **הוסתר מה-UI** (הכפתור+הדיאלוג הוסרו). ה-route קיים אך לא מקושר. | ראה "מוצרים/קטלוג מוסתרים". |

> `_ownerDialogs.ejs`: כל כפתור `apOpen('dlg-X')` דורש `<dialog id="dlg-X">` באותו קובץ — מבחן אוכף. `GET` על נתיב-פעולה מפנה ל-`/settings` (רשימת ה-redirect ב-סוף `settings.js`) — הוסף נתיב חדש גם לשם.

---

## 📷 נעילת צילום + מוצרים/קטלוג מוסתרים

**נעילת צילום (entitlement):**
- מקור אמת: `app_settings.scan_enabled` (`'0'` נעול = ברירת מחדל) דרך `services/appSettings.js` (`isScanEnabled`/`setScanEnabled`).
- **שער** ב-`app.js`: `app.use('/scan', requirePageAccess('nav_scan'), scanGate, scanRoutes)` — כשנעול מרנדר `views/scan-locked.ejs` (423) ל-GET, ומחזיר 423 לשאר.
- `res.locals.scanEnabled` נקבע ב-`app.js` (middleware) עבור ה-nav (🔒).
- **אם משנים:** ברירת המחדל נעול — לקוח חדש לא רואה צילום עד הפעלה. **מבחנים שנוגעים ל-`/scan` חייבים `setScanEnabled(true, db)` ב-setup** (`test/scan-routes.test.js`). בסיס לחבילת-צילום עתידית (X חשבוניות + חיוב לכל נוספת).

**מוצרים/קטלוג-על מוסתרים:**
- לינק "מוצרים" הוסר מ-`header.ejs`; דיאלוג "טעינת קטלוג-על" הוסר מ-`_ownerDialogs.ejs`.
- ה-route `/products` ו-`masterCatalog.js`/`catalogFile.js` **נשארו מותקנים** — מנוע הצילום עדיין משתמש בקטלוג, וזה קו-עבודה מקביל. **אל תמחק את קוד הקטלוג** בלי לתאם.

---

## 🔐 Auth, הרשאות ו-scope (קריטי ל-firewall)

- `middleware/currentUser.js` — שער אימות: קורא cookie חתום, טוען `req.user`, קובע `res.locals.can/canView`, `req.scope`. אוכף `must_change_password` ושעות-התחברות. נתיבים ציבוריים: `/login,/forgot,/reset,/invite,/privacy,/accessibility`.
- `lib/permissions.js` — `PERMISSIONS` (קטלוג), `userCan`/`canViewPage` (בעלים=תמיד true), `NAV_PAGES`/`NAV_ALLOW`/`OPEN_PATHS`, `ROLE_PRESETS`, `firstAllowedPath`.
- `middleware/requireOwner.js` — `requireOwner`,`requirePermission(key)`,`requirePageAccess(nav_key)`, ו-**`enforcePageScope`** (default-deny לפני ה-routes).
- הפרדת חברות: `lib/scope.js` (`scopeClause`), `lib/scopeGuard.js` (`assertInScope`/`scopeParam` נגד IDOR).
- **אם משנים:** נתיב חדש שדורש גישה מוגבלת → הוסף ל-`NAV_ALLOW`; ציבורי → `OPEN_PATHS` + `currentUser.js`. שינוי `requirePageAccess` במאונט = פותח/סוגר דף שלם.

---

## חוקי-על עסקיים (R-rules)
- **R1:** תשלום רק לספק+חשבונית מאושרים.
- **R2:** מספר הקצאה כפול = חסימה קשה; ספק+מספר כפול = אזהרה רכה.
- **R3:** חשבונית מס מעל סף בלי הקצאה = on_hold.
- **R5:** סכום תשלום = Σ שורות מיושמות (net; זיכוי שלילי).
שינוי כל אחד מאלה משפיע על `createInvoice`/`createPayment`/`updatePayment` — ראה `services/invoices.js` + `services/payments.js`.

---

## ✅ צ'קליסט לפני דחיפה
1. קראתי את סעיף האינווריאנטים + הפיצ'ר בטבלה.
2. סכימה? עדכנתי `schema.sql` + `migrate.js` + `schema.pg.sql`, וכל `SELECT` מפורש.
3. `npm test` ✔ + `TEST_PG=1 npm test` ✔ + `node scripts/smoke.mjs` ✔.
4. `git fetch apnew main && git rebase apnew/main`; קידמתי `BUILD_VERSION` (מספר טרי).
5. דחפתי ל-`apnew ap-control-split:main` + `origin ap-control-split`; אימתתי footer חי.
6. סכימה? הזכרתי לבעלים ללחוץ **"עדכן מסד נתונים"**.
7. עדכנתי `INDEX.md` + `CLAUDE.md`.
