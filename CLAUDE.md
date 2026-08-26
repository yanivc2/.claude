# AP Control — codebase map (for Claude)

Hebrew RTL, server-rendered accounts-payable app for a small retail group. Manages suppliers,
invoices, payments/checks, Z-reports (daily register close), deposits, bank reconciliation,
register closings, employees, and a product catalog. **Live:** https://ap-control.vercel.app

This file is the fast map of *where things live* so I don't re-read the whole tree each session.

> **Before changing any button/feature, read [`INDEX.md`](INDEX.md)** — a per-feature index of what
> each button does, how it's wired, what it's coupled to, and what breaks if you delete/change/move it.
>
> **After** any change to a feature/button/route/view/schema, invoke the **`doc-sync`** skill (no need
> to be asked): it updates INDEX.md + (only if a standing rule changed) this file, keeps this file
> short (detail → INDEX), and runs `node scripts/doc-check.mjs` so nothing load-bearing is dropped.

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
  as the submitted value + enforce required on submit. (3) **collapsible rubrics** — every `.card` with a
  direct `<h2>` becomes collapsible (accordion: opening one closes the others on the page; state in
  localStorage); skips `<details>`, `.no-collapse`, and cards with a `[required]` control. Also handles
  `<details data-accordion="grp">`.

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
- Store separation + active-store context ("חנות פעילה"): `lib/scope.js` — `authorizedStoreIds(user)`
  (null=owner; explicit `user_stores` grants else all stores in granted companies), `availableStoresFor`,
  `setUserStores`. `currentUser` sets `req.activeStoreId` + `res.locals.activeStore/availableStores` from
  the `ap_store` cookie (validated; auto-locks when one store). `POST /context/store` (`routes/context.js`,
  `/context` ∈ `OPEN_PATHS`) switches it; the header banner shows it; new invoice/zclosing forms lock to it.
  Detail → INDEX.md (invariant #11). New table `user_stores` (schema in 3 places).
- Login flow: `routes/auth.js` — checks `loginAllowedNow` (403 outside window), pushes a Telegram
  notice on every login. Forced-change + temp-password onboarding: `routes/account.js` (change form),
  `routes/settings.js` (invite builds WhatsApp msg + temp password), `services/users.js`
  (`resetPasswordByOwner` sets must_change=1; `changeOwnPassword` clears it), `lib/auth.js`
  (`hashPassword`/`verifyPassword` scrypt, `passwordPolicyError`, `generatePassword`).

## Feature → files map (buttons, wiring & impact: see [`INDEX.md`](INDEX.md))
Each area = `routes/<area>.js` + `services/<area>.js` + `views/<area>/*`:
**Dashboard** `index.js` · **Invoices** `invoices.js` · **Payments** `payments.js` · **Z-reports**
`reports.js`+`zreports.js` · **Register closing (סגירת Z)** `zclosing.js` · **Suppliers** `suppliers.js` ·
**Bank recon** `reconciliation.js` · **Employees** `employees.js` · **Deposits** `deposits.js` ·
**Settings/org** `settings.js`+`orgs.js`/`users.js` · **Reports** `reports.js` · **Calendar/audit**
`index.js`+`calendar.js`/`audit.js`/`changeRequests.js`. Business rules R1/R2/R3/R5 live in
`services/invoices.js`+`payments.js`. Buttons, couplings and "what breaks if you change it" → **INDEX.md**.
- **Shared UI:** `partials/header.ejs` (nav + 🌙/☀️ theme toggle → `data-theme`/`nocturne.css` light
  palette), `partials/footer.ejs` (day-first date picker + `js-combo` combobox enhancers — global),
  `partials/_ownerDialogs.ejs` (owner dials — a button + its `<dialog>` must ship together, a test asserts it).
- **Multi-term search:** `lib/search.js` (`parseSearchTerms`/`anyTermLike`) powers the dashboard lookup,
  invoices list, `reports.js#invoiceLookup` and `payments.js#lookupChecks`.
- **App settings / entitlements:** `services/appSettings.js` over `app_settings` (key/value). **Scan is
  locked by default** via `scan_enabled`; `app.js` gates `/scan` → `views/scan-locked.ejs` (423); owner
  toggles at `POST /settings/scan-toggle`. **Tests hitting `/scan` must `setScanEnabled(true, db)`.**
- **Products + master-catalog are HIDDEN from the UI** (nav link + "טעינת קטלוג-על" dial removed);
  `/products` + catalog services stay mounted (scan uses them; parallel line of work — don't delete).

### Scan + catalog (parallel line of work — coordinate via git; full detail in `docs/צילום-וחילוץ/`)
`routes/scan.js`+`products.js`, `services/scan.js` (needs `@anthropic-ai/sdk`), `masterCatalog.js`,
`supplierProfile.js` (per-supplier "skill"), `lib/extractValidate.js`/`ean.js`/`supplierMatch.js`/
`catalogFile.js`, `public/scan-capture.js`/`catalog-upload.js`. **Load-bearing gotchas:**
- **`EXTRACTION_SCHEMA` ≤ 16 union/nullable params** — above it the API 400s and *every* scan fails
  (`test/scan-service.test.js` counts). Text = plain string (`""`=absent); only numbers nullable.
- **Cost = pixel dims only** (`⌈w/28⌉×⌈h/28⌉`); greyscale/JPEG-quality save nothing. Lever =
  `config.ai.scanMaxEdge`; a PDF page adds 1.5–3k text tokens → in-app capture beats PDF upload.
- **Shortened barcodes:** `lookupByCodes`/`rankCandidates` resolve the EAN tail by suffix + name overlap
  (supplier only breaks ties). Everything is an **offer**, adopted on click. Read
  `docs/צילום-וחילוץ/מחקרים/תקלות-ופתרונן.md` before debugging this area.

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
- **`x.run('INSERT…')` auto-appends `RETURNING id`** (`db/adapter.js`) — on a table whose PK isn't
  `id` (e.g. `app_settings.key`, `invoice_ocr.invoice_id`) the PG insert crashes. Add an explicit
  `RETURNING <pk>` to the SQL.
- pg-mem names inline CHECK constraints differently than real PG (`t_constraint_1` vs
  `payments_method_check`); to add a CHECK value, update the inline CREATE **and** append an ALTER.
- The custom date picker (`partials/footer.ejs`) enhances `input[type=date]` only — `type=time`/`month`
  stay native.
- Badge classes: `b-approved/paid/cleared/on_hold/blocked/voided/neutral` (no `b-warn`; use `b-on_hold`).
