# AP Control — codebase map (for Claude)

Hebrew RTL, server-rendered accounts-payable app for a small retail group. Manages suppliers,
invoices, payments/checks, Z-reports (daily register close), deposits, bank reconciliation,
register closings, employees, and a product catalog. **Live:** https://ap-control.vercel.app

This file is the fast map of *where things live* so I don't re-read the whole tree each session.

> **Before changing any button/feature, read [`INDEX.md`](INDEX.md)** — a per-feature index of what
> each button does, how it's wired, what it's coupled to, and what breaks if you delete/change/move
> it, plus the load-bearing invariants that fail silently. Keep both files updated when a feature changes.

## Deploy & branch workflow (IMPORTANT)
- Work happens on branch **`ap-control-split`**. It tracks **`apnew/main`** (github.com/yanivc2/ap-control),
  which is what Vercel deploys. Push with: `git push apnew ap-control-split:main`.
- Also mirror to `origin/ap-control-split` (github.com/yanivc2/.claude) so the stop-hook is happy:
  `git push origin ap-control-split`.
- `apnew/main` can advance from other sessions (e.g. a product-catalog line of work). **Fetch &
  rebase** onto it before pushing; never force-overwrite others' commits (force-with-lease only to
  replace my own superseded pre-rebase commits).
- **`BUILD_VERSION`** in `src/app.js` is bumped every deploy and shown on the login page footer.
  Verify a deploy is live: `curl -s https://ap-control.vercel.app/login | grep -o "v<version>"`.
- **Live DB is Postgres (Neon).** `connectDb()` does NOT apply schema on serverless boot — after any
  schema change the owner must click **Settings → "עדכן מסד נתונים"** (runs `upgradeSchema()` =
  re-applies `schema.pg.sql`). Tell the user this whenever I add a column/table.
- I have **no access to the live Neon DB.** Company names, users, etc. are runtime data the owner
  edits in Settings — my deploys can't change existing rows, only code/schema.

## Multi-session work (IMPORTANT)
Several Claude sessions work on this app at once — **each session is its own branch**, and they
all deploy through the one trunk `apnew/main`. Branches don't collide while separate; collisions
happen only at merge. So:
- **git is the shared memory.** Sessions don't talk directly — they coordinate through `apnew/main`.
  A session learns what others did by fetching it. So: **start from the latest `apnew/main`, and
  `git fetch apnew main && git rebase apnew/main` right before every push.** This session did that
  on every push; keep doing it.
- **Never force-overwrite another session's commits.** Rebase onto them (force-with-lease only to
  replace my *own* superseded pre-rebase commit).
- **Don't edit the same files as another active session at the same time.** If two must touch the
  same area, sequence it: one merges, the other rebases on top. Check `git log apnew/main` (and, if
  needed, `mcp__claude-code-remote__list_sessions`) to see what's in flight before starting related
  work.
- **`BUILD_VERSION` collides across sessions** (two sessions both bump to the same `·NN`). After a
  rebase, take a *fresh* number and re-verify the live footer.
- **Only `apnew/main` is live.** Work on an unmerged branch is invisible to the app (Vercel deploys
  the ap-control repo's `main`). Merging into the `.claude` repo does NOT affect the app.
- **A bad merge is reversible** — `git revert` the commit and redeploy; nothing is lost. So the rule
  isn't "never merge", it's **review the diff + run tests before merging**; `main` = production.
- **Other lines of work seen on this app** (branches may still be active): invoice capture/extraction
  + per-supplier profiles (`services/supplierProfile.js`), catalog/barcode matching, and a separate
  `supplier-orders` repo (price scraping). Don't duplicate their area — coordinate via git.

## Run & test
- `npm test` → SQLite dialect. `TEST_PG=1 npm test` → Postgres dialect (pg-mem). **Run both** before pushing.
- `node scripts/smoke.mjs [paths...]` → boots the real app + an owner session and asserts pages render
  (catches EJS regressions unit tests miss). Default paths cover the main screens.
- Tests live in `test/*.test.js` (~48 files). Helpers: `test/helpers.js` → `freshDb()` (schema+seed,
  SQLite or PG via `TEST_PG`), `owner(x)`, `secretary(x)`, `firstStore(x)`, `accountForStore(x, id)`.

## Stack & core patterns
- Node **ESM**, **Express 4**, **EJS** server-rendered (Hebrew RTL), PWA. No client framework.
- **Dual DB** via `src/db/adapter.js` (`getExecutor()`): SQLite (`better-sqlite3`) locally/tests,
  Postgres (Neon) in prod. Executor API: `x.one(sql, params)` (→ row or **undefined**),
  `x.many(...)`, `x.run(...)` (→ `{lastInsertRowid}`), `tx(async t => …)`. Placeholders are `?`
  (adapter rewrites to `$n` for PG).
- **Money = integer agorot** (₪1 = 100). `lib/money.js`: `toAgorot()` ('' → 0), `fromAgorot`, `formatIls`.
- **Schema lives in 3 places — keep in sync when adding a column/table:**
  1. `src/db/schema.sql` (SQLite, fresh installs)
  2. `src/db/migrate.js` (SQLite migrations for existing DBs — PRAGMA table_info + ADD COLUMN; CHECK
     changes need a table rebuild, see `migrateStandingOrder`)
  3. `src/db/schema.pg.sql` (Postgres; `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF
     NOT EXISTS` at the bottom for existing-DB migrations). Order matters (FKs validated at create).
  - **Gotcha:** services often `SELECT` explicit column lists (e.g. `getUser`/`listUsers` in
    `services/users.js`) — add new columns there too or they'll be `undefined` in views.
- **Israel time:** `lib/loginHours.js#israelClock()` and `services/zclosing.js#israelNow()` use
  `Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem' })`.
- **Telegram push:** `lib/notify.js#notify(html)` — fire-and-forget, no-op if unconfigured. Never throws.
- **Dates:** stored ISO `YYYY-MM-DD`; `res.locals.formatDate` → `DD/MM/YY`.
- **`partials/footer.ejs` global enhancers** (run on every page): (1) the **day-first date picker**
  replaces every `input[type=date]` — displays `DD/MM/YY`, and on pointer-fine (desktop) is **typable**
  (`parseTyped` accepts `6/8/26`→`2026-08-06`); touch keeps the readonly picker. (2) the **searchable
  combobox** enhances `<select class="js-combo">` (type-to-filter). Both keep a hidden/original control
  as the submitted value + enforce required on submit.

## Auth, permissions & scope
- `middleware/currentUser.js` — auth gate: reads signed `session` cookie, loads user, sets
  `req.user`, `res.locals.can/canView`, `req.scope`. Enforces **must_change_password** and
  **login hours** here (both bounce to a page/redirect). Public paths: /login,/forgot,/reset,/privacy,/accessibility.
- `lib/permissions.js` — the model:
  - `PERMISSIONS` catalog (groups 'עמודים' pages / 'פעולות' actions, each with icon+desc).
  - `userCan(user, perm)` (owner always true; strict for others), `canViewPage(user, nav_key)`.
  - `NAV_PAGES` (nav_key → path), `NAV_ALLOW` (page → allowed URL prefixes), `OPEN_PATHS`.
  - `ROLE_PRESETS` (one-click presets: secretary/store_manager/cashier/invoice_scanner/viewer).
  - `firstAllowedPath(user)` (login landing for restricted roles).
- `middleware/requireOwner.js` — `requireOwner`, `requirePermission(key)`, `requirePageAccess(nav_key)`,
  and **`enforcePageScope`** = global default-deny firewall (mounted in app.js before routes) so a
  restricted role (e.g. cashier → only /zclosing) can't reach any other detail/CSV/action path.
- Company separation ("הפרדת חברות"): `lib/scope.js` — `authorizedCompanyIds(user)` (null = owner/all),
  `scopeClause(scope, col)` → `{sql, params}` appended to WHERE. `lib/scopeGuard.js#assertInScope` +
  `scopeParam` guard id-bearing routes against IDOR.
- Login flow: `routes/auth.js` — checks `loginAllowedNow` (403 outside window), pushes a Telegram
  notice on every login. Forced-change + temp-password onboarding: `routes/account.js` (change form),
  `routes/settings.js` (invite builds WhatsApp msg + temp password), `services/users.js`
  (`resetPasswordByOwner` sets must_change=1; `changeOwnPassword` clears it), `lib/auth.js`
  (`hashPassword`/`verifyPassword` scrypt, `passwordPolicyError`, `generatePassword`).

## Feature → files index
- **Dashboard:** `routes/index.js` (`/`), `views/dashboard.ejs`. Cubes: pending suppliers, on-hold
  invoices, last reconcile, open-checks count, unmatched cash, deposits history, Z-sequence gaps.
  Lookup box (`q`) does **multi-term search** (`lib/search.js` `parseSearchTerms`/`anyTermLike` —
  split on space/comma/;/newline, OR-match) over invoice#/allocation/supplier (`invoiceLookup`) and
  check#/reference (`lookupChecks`); a "רק שלא שולמו" checkbox (`unpaid=1`) filters to `status<>'paid'`.
- **Suppliers:** `routes/suppliers.js`, `services/suppliers.js`, `views/suppliers/*`. Multi-store
  assignment via `supplier_stores` (`_storepick.ejs`); payment methods incl אשראי/הו"ק.
- **Supplier "skill" (`suppliers.scan_profile`):** every supplier accumulates a profile of how
  ITS invoice is laid out — `services/supplierProfile.js`. Structure is **measured** from each
  approved scan (code lengths + GTIN checksum → shortened-barcode vs full; is there a כ.בודד
  column; is an allocation number ever printed), and repeated human corrections become hints only
  after **2** occurrences. Hints ride in the **user message**, never the `cache_control:ephemeral`
  system prompt (a test asserts the prompt is byte-identical with and without them). Naming the
  supplier on the capture screen (`invoice_drafts.supplier_id`) is what gets the profile into the
  FIRST pass. `חדש → לומד → מוכן`, where מוכן = 3 consecutive scans approved with zero corrections.
  **Gotcha it was born from:** the model returns `06/08/2026`+shekels and the draft holds
  `2026-08-06`+agorot, so a raw diff counts the validator's own normalization as human
  corrections — every field goes through the same conversion before comparison.
  See `docs/צילום-וחילוץ/פרופילי-ספקים/`.
- **Scan → existing invoice:** a scan whose supplier + invoice number match an invoice already on
  file is **attached** to it (`attachToInvoice` in `services/scan.js`) instead of creating a
  duplicate payable: its photo fills an empty `image_path`, its lines are inserted only when the
  invoice has none, and **recorded amounts are never overwritten** — a difference comes back as
  `attach_amount_differs`. `approveDraft` returns `{invoiceId, attached}`.
- **Invoices:** `routes/invoices.js`, `services/invoices.js`, `views/invoices/*`. `_zform`? no — invoice
  `new.ejs` has an inline payment section (methods: check/transfer/cash/credit/standing_order) that
  auto-creates a payment on save (R1/R5 enforced). Cash-in-Z payments surface via
  `zreports.cashPaymentsForInvoice`.
  - **Detail page (`show.ejs`)** shows the invoice number + an **אפשרויות** menu (edit_invoice →
    ערוך חשבונית; approve_payment + a payment exists → ערוך אמצעי תשלום) and a "לאותו ספק" link →
    `/invoices/new?supplier=&store=` (batch mode). The menu shows even after the invoice is **paid**.
  - **Supplier field is a searchable combobox** (`<select class="js-combo">`, enhanced in `footer.ejs`)
    — type part of a name → filtered matches; the `<select>` stays the submitted control.
  - **List filter (`index.ejs`):** status tabs incl. a virtual **`unpaid`** (`status<>'paid'`, use with
    the supplier filter); `q` is multi-term (invoice#/allocation/supplier).
  - **"צרף חשבונית פתוחה"** on `new.ejs`: a dialog of open payable invoices (`listPayable`); pick some
    of ONE supplier → navigates to `?supplier=&store=&pick=ids` and pre-checks them in the batch section.
  - **Allocation number** accepts **≥6 digits** now (was exactly 9) — `normalizeAllocation` `/^\d{6,}$/`,
    inputs `pattern="\d{6,}"` in new/edit/show/OCR-apply.
- **Payments/checks:** `routes/payments.js`, `services/payments.js`. `createPayment` enforces R1
  (approved supplier + invoice) & R5 (amount == Σ applied lines). Methods in `METHODS`.
  `earlyPaymentAlerts`/`parsePaymentTermsDays` → Telegram push when paid earlier than terms.
  - **`updatePayment` + `/payments/:id/edit` (`payments/edit.ejs`, approve_payment):** edit method /
    identifier / date; and (issued + not bank-matched only) **re-target the applied invoices** — add a
    credit note so net = the real check amount (R5 preserved; amount is derived, never free-typed).
  - **A voided check releases its number:** `ux_payments_account_check` excludes `status='voided'`, so a
    corrected check can reuse the same number. create/updatePayment pre-check for an *active* duplicate
    and throw a Hebrew message instead of the raw PG constraint error.
- **Z-reports:** `routes/reports.js` (`/reports/zreports`, also outstanding/profitability/lookup CSVs),
  `services/zreports.js`, `views/reports/_zform.ejs` (shared add/edit form), `zreport.ejs`, `zreports.ejs`.
  Cash-expense rows have a **kind** (manual/salary/advance/invoice) → `description_type`, linking an
  employee or invoice. Credit-card reconcile, deposit recon (חוסר/יתרה), Z-number gap detection.
- **Deposits:** `services/deposits.js` ("הצהרות הפקדה"), reconciled to bank by bag=reference.
- **Register closing (סגירת Z):** `routes/zclosing.js`, `services/zclosing.js`, `views/zclosing/*`.
  Cashier role is locked to this page by the firewall. Rich cash expenses (kinds manual/salary/
  advance/invoice, `z_closing_expenses`) + **"איזון קופות"** — repeatable per-register cash count
  (`z_closings.registers` JSON, `normalizeRegisters`), counted before the Z, independent of the drawer.
- **Employees & salaries:** `routes/employees.js`, `services/employees.js`, `views/employees/*`.
  Advances/salary lines from Z feed the tracking ledger + per-employee totals.
- **Reconciliation (bank):** `routes/reconciliation.js`, `services/reconciliation.js`,
  `services/bankTransactions.js`, `lib/bankCsv.js` (Hapoalim CSV/XLSX import).
- **Reports:** profitability (weekly/monthly/range selector, visible at top of `profitability.ejs`),
  outstanding checks (monthly cut `outstandingMonths`), invoice lookup — all in `services/reports.js`.
- **Settings/org:** `routes/settings.js`, `services/orgs.js` (companies/stores/accounts; `deleteStore`),
  `services/users.js`, `services/roleTemplates.js`, `views/settings/*` (`_permpicker.ejs` visual perms,
  company×user matrix, guide.ejs). Owner dials live in `partials/_ownerDialogs.ejs` (button + its
  dialog must ship together — a test asserts it). Backup/restore/reset in `services/backup.js`, incl.
  **`cleanStartInvoicesPaymentsZ`** ("התחלה נקייה" — wipes invoices/payments/Z reports/scan drafts,
  KEEPS z_closings + suppliers + catalog + employees + deposits; nulls dead FKs first, deletes
  child-before-parent). Owner-password-guarded like the other destructive dials.
- **App settings / entitlements:** `services/appSettings.js` over the `app_settings` key/value table
  (`getSetting`/`setSetting` — the INSERT needs an explicit `RETURNING key` so the PG adapter doesn't
  inject `RETURNING id` on a table whose PK isn't `id`). Holds `scan_enabled` (see Scan lock below).
- **Light mode:** the whole UI is token-driven, so `nocturne.css` defines a light palette under
  `:root[data-theme="light"]`. A nav toggle (`partials/header.ejs`, 🌙/☀️) persists `ap-theme` to
  localStorage; an inline `<head>` script applies it before first paint. Default = dark.
- **Scan lock (entitlement):** invoice scanning is **locked by default** behind `app_settings.scan_enabled`
  (`isScanEnabled`/`setScanEnabled`). `app.js` gates the `/scan` mount: when disabled it renders
  `views/scan-locked.ejs` (423) instead of the scanner, and sets `res.locals.scanEnabled` for the nav
  (🔒 "נעול"). Owner toggles via **`POST /settings/scan-toggle`** (a dial on the settings page).
  Groundwork for a future scan package (N invoices included, then per-invoice billing). **Route/service/
  view tests that hit `/scan` must `setScanEnabled(true, db)` in setup** (see `test/scan-routes.test.js`).
- **Products page + master-catalog upload are HIDDEN from the UI** (owner asked to remove them): the
  "מוצרים" nav link and the Settings "טעינת קטלוג-על" dial+dialog are gone. The `/products` route and
  all catalog services stay mounted — the scan matcher still uses them, and it's a parallel line of work.
- **Scan + catalog (from a parallel line of work):** `routes/scan.js`+`products.js`,
  `services/scan.js` (needs `@anthropic-ai/sdk`), `services/masterCatalog.js`/`products.js`,
  `lib/priceXml.js`/`ean.js`/`extractValidate.js`/`supplierMatch.js`/`pdfPages.js`.
  - **Mobile capture:** `views/scan/capture.ejs` is just markup; `public/scan-capture.js` is the
    whole flow. The OS camera (`<input capture="environment">`) is the only camera path — the
    OpenCV viewfinder/auto-crop scanner was **removed** in round 11 because the owner measured a
    plain photo as better input, and its two CSP relaxations went with it. Each captured page is
    scored for blur (`σ(∇²I)/σ(I)` at a fixed 640px working size, `SHARP_MIN = 0.25`) → red/green
    frame + "צלם שוב"; a warning, never a block. The threshold is calibrated by
    `scripts/sharpness-calibrate.mjs` and `test/sharpness.test.js` asserts the script and the
    browser score identically.
  - **Cost model — don't guess:** the API bills an image on **pixel dimensions only**
    (`⌈w/28⌉ × ⌈h/28⌉` tokens). Greyscale saves **nothing**; JPEG quality saves nothing.
    `config.ai.scanMaxEdge` (1800) is the real lever, and a PDF page costs an extra
    1,500–3,000 text tokens on top of its image — so in-app capture beats uploading a PDF.
  - **`EXTRACTION_SCHEMA` has a hard ceiling of 16 union-typed (nullable) params** — the API
    400s above it and *every* scan fails. Text fields are plain strings, `""` = absent
    (`str()` maps it to null); only numbers stay nullable. `test/scan-service.test.js` counts them.
  - **Shortened barcodes:** many suppliers print only the tail of the EAN (Tnuva prints `42435`
    for `7290000042435`). `lookupByCodes()` resolves a printed code of ≥5 digits by suffix, over
    both the barcode and the מק"ט column. Several candidates are **ranked** by `rankCandidates()`
    (`extractValidate.js`): name overlap with the printed description decides (measured: it
    separates 97% of ambiguous groups; manufacturer only 26%, and that column is usable on just
    44.6% of rows), + a supplier bonus that applies **only among candidates whose name evidence is
    tied** — measured on the catalog, for a 5-digit code the right product has no manufacturer
    while a wrong candidate does in **17.9%** of cases, so a flat bonus would adopt the wrong
    product there. Supplier breaks ties; it never outvotes the description. A clear
    winner → `catalog_suffix_match`, otherwise `catalog_ambiguous` with the list ranked. Code
    length drives the badge: per product, a 5-digit code is ambiguous 56.8% of the time,
    6 digits 11.2%, 7 digits 1.1%, 8 digits 0.2%.
    Everything is an **offer** — the review screen adopts on a click, nothing is ever written
    automatically. `test/catalog-identify.test.js` is the known-answer test over the 30 codes on
    a real Tnuva invoice; see `docs/צילום-וחילוץ/קטלוגים/זיהוי-מוצר.md`.
  - **Catalog upload (הגדרות ← 🏷️ טעינת קטלוג-על):** `lib/catalogFile.js` maps Hebrew headers,
    repairs Excel-stripped leading zeros by GTIN check digit, and takes the median of a
    per-chain price column set. `lib/xlsxRead.js` reads .xlsx with no dependency. Because of the
    4.5MB body limit (see Gotchas) the browser reads the file itself —
    **`public/catalog-upload.js`** streams the zip and posts rows to
    `/settings/catalog-import/{prepare,batch}`; the single-shot `POST /settings/catalog-import`
    remains as the fallback. The xlsx reader exists in both places on purpose and
    `test/catalog-upload.test.js` asserts the two agree.
- **📁 `docs/צילום-וחילוץ/`** — the project dossier for capture + extraction: catalog sources and
  the product-identity rules, how the scanner and the extraction are built, the cost model, and
  the research log (including a "faults and their real causes" file worth reading before
  debugging this area — every one of them looked like a different problem than it was).
- **Calendar/audit:** `routes/index.js` (`/audit`), `services/calendar.js`, `services/audit.js`
  (`logAction`), `services/changeRequests.js` (non-owner edits queued for approval → `/approvals`).

## Adding a DB column — checklist
1. `schema.sql` (SQLite CREATE) + `schema.pg.sql` (CREATE + bottom `ALTER … ADD COLUMN IF NOT EXISTS`).
2. `migrate.js` (SQLite `ADD COLUMN` guard).
3. Any explicit-column `SELECT`s in the relevant service (esp. users).
4. Service create/update to persist it; route to pass it; view to show it.
5. Tests (SQLite + PG) + `scripts/smoke.mjs`. Bump `BUILD_VERSION`. Remind owner to run "עדכן מסד נתונים".

## Gotchas
- **Vercel rejects a request body over ~4.5MB** at the platform edge, before Express runs — the
  response is a bare English `413 FUNCTION_PAYLOAD_TOO_LARGE` page and **nothing appears in the
  logs**. `multer`'s own limit is irrelevant. A large upload must be split client-side; the
  catalog import is the worked example (`src/public/catalog-upload.js` reads the file in the
  browser and posts ~2,000 rows per request).
- `x.one` returns **undefined** (not null) when no row — assert with `!row`, not `=== null`.
- pg-mem names inline CHECK constraints differently than real PG (`t_constraint_1` vs
  `payments_method_check`); to add a CHECK value, update the inline CREATE **and** append an ALTER.
- The custom date picker (`partials/footer.ejs`) enhances `input[type=date]` only — `type=time`/`month`
  stay native.
- Badge classes: `b-approved/paid/cleared/on_hold/blocked/voided/neutral` (no `b-warn`; use `b-on_hold`).
