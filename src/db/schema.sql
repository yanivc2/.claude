-- AP Control — schema (stage 1)
-- All monetary amounts are stored as INTEGER agorot (1 ILS = 100 agorot) to avoid
-- floating-point drift in control rules (esp. R5: check total == sum of applied lines).
-- Dates are stored as ISO strings 'YYYY-MM-DD'. Timestamps as 'YYYY-MM-DD HH:MM:SS' (UTC).

PRAGMA foreign_keys = ON;

-- §4 companies ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  company_type TEXT,                 -- e.g. 'ltd' (בע"מ)
  tax_id       TEXT                  -- ח.פ. — nullable until confirmed (§2, §11.3)
);

-- §4 stores ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name       TEXT NOT NULL,
  address    TEXT
);

-- §4 bank_accounts — 1:1 with a store -------------------------------------------
CREATE TABLE IF NOT EXISTS bank_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id),
  store_id       INTEGER NOT NULL UNIQUE REFERENCES stores(id),  -- 1:1 enforced
  bank_name      TEXT NOT NULL DEFAULT 'הפועלים',
  branch         TEXT NOT NULL,
  account_number TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  -- Open-Banking link (Financy / open-finance.ai): the provider's account id for this account.
  -- NULL = not linked; the bank-sync button is only offered for a linked account.
  financy_account_id TEXT
);

-- §4 suppliers ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,                 -- canonical / normalized
  tax_id      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','blocked')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  notes       TEXT,
  -- § priority 3: supplier contact details + bookkeeping contact
  phone          TEXT,
  email          TEXT,
  contact_name   TEXT,   -- accounting/bookkeeping contact person
  contact_phone  TEXT,
  payment_method TEXT,   -- העברה / צק / מזומן / אשראי / הו"ק (transfer/check/cash/credit/standing_order)
  payment_terms  TEXT,   -- מיידי / דחוי 14 / 30 / 45 / טקסט חופשי
  -- עסקאות בשיעור אפס (§30(א)(13)) — ספק פירות וירקות טריים. אינו משנה את R3 (שנבדק לפי המע"מ
  -- בפועל שעל החשבונית), רק משתיק את אזהרת "חשבונית מס גדולה בלי מע"מ — שכחת להזין?" שאחרת
  -- הייתה נורית על כל חשבונית של הספק הזה.
  zero_rated     INTEGER NOT NULL DEFAULT 0,
  -- Where a transfer to this supplier may go. Owner-only; every change is kept in
  -- supplier_bank_changes and shown at the moment a transfer to them is approved.
  bank_name      TEXT,
  bank_branch    TEXT,
  bank_account   TEXT,
  bank_holder    TEXT,   -- שם בעל החשבון — must match the supplier, or it is a red flag
  bank_updated_at TEXT,
  bank_updated_by INTEGER REFERENCES users(id),
  -- "הסקיל של הספק": what this supplier's invoices LOOK LIKE, learned from its own scans —
  -- which column holds the product code and what shape it is, whether there is a כ.בודד column,
  -- whether an allocation number is ever printed, the date format, and what humans keep
  -- correcting. Sent back to the extractor on the next scan so it knows where to look.
  -- JSON; see src/services/supplierProfile.js for the shape.
  scan_profile   TEXT,
  -- Consolidated payment: a subsidiary (e.g. טרה) points at its parent (e.g. קוקה קולה) so their
  -- open invoices can be paid together in one payment. NULL = a top-level supplier.
  parent_supplier_id INTEGER REFERENCES suppliers(id)
);

-- Which stores a supplier serves (many-to-many). Shown on the suppliers page; a supplier may
-- be assigned to one or more stores.
CREATE TABLE IF NOT EXISTS supplier_stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  store_id    INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  UNIQUE (supplier_id, store_id)
);
CREATE INDEX IF NOT EXISTS ix_supplier_stores_supplier ON supplier_stores(supplier_id);


-- §4 users ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','secretary')),
  username      TEXT,           -- login handle (unique when set)
  email         TEXT,           -- for password-reset by email
  label         TEXT,           -- optional display role name (e.g. "מנהל")
  permissions   TEXT,           -- JSON array of granted permission keys (non-owner)
  phone         TEXT,           -- E.164-ish digits for WhatsApp invites (optional)
  password_hash TEXT,           -- scrypt hash; null until a password is set
  must_change_password INTEGER NOT NULL DEFAULT 0, -- 1 = force a password change on next login
  login_start   TEXT,           -- 'HH:MM' Israel time; login allowed only from this time…
  login_end     TEXT            -- …until this time (both set = restricted; null = always allowed)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users(username) WHERE username IS NOT NULL;

-- Per-user company access (הפרדת חברות). A non-owner sees ONLY the companies listed here;
-- an owner ignores this table and sees everything. No rows for a non-owner = sees nothing.
CREATE TABLE IF NOT EXISTS user_companies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  UNIQUE (user_id, company_id)
);

-- Per-user store access (הרשאה פר-חנות). Finer than user_companies: an owner sees all stores; a
-- non-owner with rows here is limited to exactly those stores. A non-owner with NO rows here falls
-- back to all stores in their granted companies (backward compatible with company-only grants).
CREATE TABLE IF NOT EXISTS user_stores (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  UNIQUE (user_id, store_id)
);

-- Password-reset tokens (email flow). Only a SHA-256 hash of the token is stored.
CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,           -- ISO 'YYYY-MM-DDTHH:MM:SSZ'
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_password_resets_token ON password_resets(token_hash);

-- Calendar events / reminders shown on the "יומן" page. remind=1 + a time triggers a push
-- (Telegram) reminder once (remind_sent flips to 1).
CREATE TABLE IF NOT EXISTS calendar_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  event_date  TEXT NOT NULL,              -- 'YYYY-MM-DD'
  event_time  TEXT,                       -- 'HH:MM' (optional)
  remind      INTEGER NOT NULL DEFAULT 0, -- 0/1
  remind_sent INTEGER NOT NULL DEFAULT 0, -- 0/1
  created_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_calendar_events_date ON calendar_events(event_date);

-- Approval workflow: edits by non-owners are queued here for the owner to approve/reject.
CREATE TABLE IF NOT EXISTS change_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_by      INTEGER REFERENCES users(id),
  requested_by_name TEXT,
  action            TEXT NOT NULL,          -- e.g. 'invoice.update'
  entity_type       TEXT,
  entity_id         INTEGER,
  payload           TEXT NOT NULL,          -- JSON to apply on approval
  summary           TEXT,                   -- human-readable description of the change
  status            TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
  decided_by        INTEGER,
  decided_at        TEXT,
  decision_note     TEXT,
  result_summary    TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_change_requests_status ON change_requests(status);

-- In-app notification stream (a bell + /notifications page) — the same alerts pushed to Telegram
-- are also recorded here, so the owner isn't dependent on Telegram. read_at is a single global
-- read marker (the bell is owner-facing).
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'alert',
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_notifications_created ON notifications(created_at);

-- "דוח פדיון" — the nightly revenue report per store (Midnight first): total sales + the credit
-- clearing figure for one business day. Arrives as an XLS (uploaded, or ingested from the nightly
-- email) and is the SYSTEMATIC sales source for profitability — Z reports are entered irregularly.
-- One row per store per day; re-importing the same day replaces it.
CREATE TABLE IF NOT EXISTS revenue_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  report_date  TEXT NOT NULL,                    -- 'YYYY-MM-DD' (the business day)
  gross_sales  INTEGER NOT NULL DEFAULT 0,       -- agorot — סך המכירות
  credit_total INTEGER NOT NULL DEFAULT 0,       -- agorot — סליקות אשראי
  source       TEXT NOT NULL DEFAULT 'upload',   -- upload | email
  created_at   TEXT NOT NULL,
  UNIQUE (store_id, report_date)
);
CREATE INDEX IF NOT EXISTS ix_revenue_reports_date ON revenue_reports(report_date);

-- §4 invoices -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id        INTEGER NOT NULL REFERENCES suppliers(id),
  company_id         INTEGER NOT NULL REFERENCES companies(id),
  store_id           INTEGER NOT NULL REFERENCES stores(id),
  bank_account_id    INTEGER REFERENCES bank_accounts(id),   -- nullable until paid
  invoice_number     TEXT NOT NULL,
  allocation_number  TEXT,                                    -- 9 digits, nullable
  invoice_date       TEXT NOT NULL,
  amount_before_vat  INTEGER NOT NULL,                        -- agorot
  vat_amount         INTEGER NOT NULL DEFAULT 0,              -- agorot
  total_amount       INTEGER NOT NULL,                        -- agorot (negative for credit_note)
  doc_type           TEXT NOT NULL
                     CHECK (doc_type IN ('tax_invoice','tax_invoice_receipt','credit_note')),
  image_path         TEXT,                                    -- stage 1b
  status             TEXT NOT NULL DEFAULT 'recorded'
                     CHECK (status IN ('recorded','approved_for_payment','on_hold','paid')),
  hold_reason        TEXT,                                    -- why on_hold (e.g. R3)
  created_by         INTEGER NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);

-- Dedup (R2): allocation_number is a strong key — unique when present.
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_allocation
  ON invoices(allocation_number) WHERE allocation_number IS NOT NULL;
-- Secondary dedup signal: same supplier + same invoice number.
CREATE INDEX IF NOT EXISTS ix_invoices_supplier_number
  ON invoices(supplier_id, invoice_number);

-- §4 payments — checks and other methods (cash / credit / transfer / batch) ------
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  method          TEXT NOT NULL DEFAULT 'check'
                  CHECK (method IN ('check','cash','credit','transfer','batch','standing_order')),
  check_number    TEXT,                                       -- method=check
  reference       TEXT,                                       -- transfer/batch אסמכתא (matches bank)
  payer_name      TEXT,                                       -- cash: שם המשלם
  card_last4      TEXT,                                       -- credit: 4 ספרות אחרונות
  batch_number    TEXT,                                       -- batch: מספר מקבץ
  payment_date    TEXT NOT NULL,
  amount          INTEGER NOT NULL,                           -- agorot
  status          TEXT NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued','cleared','voided')),
  cleared_date    TEXT,
  -- Who the money went to. Normally derivable through payment_lines, but an ADVANCE (a payment
  -- made before its invoice exists — e.g. 12 rent checks handed over up front) has no lines yet,
  -- so the supplier has to be recorded on the payment itself.
  supplier_id     INTEGER REFERENCES suppliers(id),
  -- ביטול צ'ק — why, when and by whom, plus the link the reason demands. A voided check is not
  -- forgotten: it stays cashable for six months, so "צ'קים מבוטלים" tracks it until it is safe.
  void_reason        TEXT
                     CHECK (void_reason IS NULL OR void_reason IN ('not_collected','cashed_for_salary','method_changed','row_cancelled')),
  voided_at          TEXT,
  voided_by          INTEGER REFERENCES users(id),
  void_link_payment_id INTEGER REFERENCES payments(id),      -- שינוי אמצעי תשלום → התשלום החדש
  void_link_invoice_id INTEGER REFERENCES invoices(id),      -- ביטול שורה בתוכנה → השורה שבוטלה
  void_cash_expense_id INTEGER REFERENCES z_closing_expenses(id) ON DELETE SET NULL, -- נפרע במזומן
  -- Alerts already sent, so a nightly/reconcile sweep does not push the same thing every time.
  void_alerted       TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
-- A check number is unique within a bank account (checks only, and only among LIVE payments —
-- a voided check releases its number so a corrected one can be re-issued with the same number).
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_account_check
  ON payments(bank_account_id, check_number) WHERE check_number IS NOT NULL AND status <> 'voided';

-- §4 payment_lines (check <-> invoices/credit notes) ----------------------------
CREATE TABLE IF NOT EXISTS payment_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id     INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id     INTEGER NOT NULL REFERENCES invoices(id),
  amount_applied INTEGER NOT NULL                             -- agorot (negative for credit)
);
-- An invoice can be applied to a payment only once.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_lines_invoice
  ON payment_lines(payment_id, invoice_id);

-- §4 bank_transactions (stage 2 — table created now, matching engine is stage 2) -
CREATE TABLE IF NOT EXISTS bank_transactions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id    INTEGER NOT NULL REFERENCES bank_accounts(id),
  txn_date           TEXT NOT NULL,
  amount             INTEGER NOT NULL,                         -- agorot
  description        TEXT,
  raw_reference      TEXT,
  balance_after      INTEGER,                                  -- agorot; running balance if the export provides it
  source             TEXT NOT NULL DEFAULT 'scraper',
  -- Provider's own transaction id (Financy `SK`). NULL for CSV/manual rows. When present it is
  -- the dedupe key, so re-pulling an overlapping date window never duplicates a line.
  external_id        TEXT,
  matched_payment_id INTEGER REFERENCES payments(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_txn_external
  ON bank_transactions(bank_account_id, external_id) WHERE external_id IS NOT NULL;

-- invoice_ocr — stage 3. OCR result for an invoice image: raw recognized text and the
-- fields extracted from it (JSON). Kept in a separate table so existing databases need no
-- migration (CREATE TABLE IF NOT EXISTS). OCR is decision support only — never overwrites
-- the human-entered invoice values; it is compared against them (§3/§8).
CREATE TABLE IF NOT EXISTS invoice_ocr (
  invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  raw_text   TEXT,
  extracted  TEXT,                 -- JSON of extracted candidate fields
  provider   TEXT,                 -- e.g. 'tesseract'
  ran_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);

-- z_reports — daily register (Z) close per store (priority 2 module). daily_total ("יומי Z")
-- drives the profitability report; the drawer/deposit/credit-card fields support end-of-day
-- reconciliation. Columns for later sub-phases (deposit/cc) are included now to avoid re-migration.
CREATE TABLE IF NOT EXISTS z_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id         INTEGER NOT NULL REFERENCES stores(id),
  z_number         TEXT NOT NULL,
  z_date           TEXT NOT NULL,
  daily_total      INTEGER NOT NULL DEFAULT 0,   -- יומי Z (agorot) — profitability source
  -- דוח מגירה
  drawer_cash      INTEGER NOT NULL DEFAULT 0,
  drawer_check     INTEGER NOT NULL DEFAULT 0,
  drawer_credit    INTEGER NOT NULL DEFAULT 0,
  drawer_hakafa    INTEGER NOT NULL DEFAULT 0,   -- הקפה
  drawer_vouchers  INTEGER NOT NULL DEFAULT 0,   -- תווי קניה
  drawer_total     INTEGER NOT NULL DEFAULT 0,   -- סה"כ מגירה (auto = sum of the five above)
  -- הפקדות (phase 2c)
  deposit_amount   INTEGER,
  deposit_bag      TEXT,
  deposit_breakdown TEXT,                         -- JSON of bill counts
  -- כרטיסי אשראי (phase 2d)
  cc_kal INTEGER, cc_isracard INTEGER, cc_diners INTEGER, cc_amex INTEGER, cc_leumi INTEGER,
  cc_general INTEGER, cc_tourist INTEGER, cc_total INTEGER,
  status           TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','unmatched')),
  reconcile_notes  TEXT,
  image_path       TEXT,                         -- scan of the printed Z slip
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  updated_at       TEXT,                           -- last edit (date+time); NULL until first edited
  manager_breakdown TEXT                           -- JSON {denom:{count,ok}} — manager's bill recount vs the Z closing
);
CREATE INDEX IF NOT EXISTS ix_zreports_store_date ON z_reports(store_id, z_date);

-- employees — staff for the "עובדים ומשכורות" page. Advances (מפרעה) / salary lines entered on
-- a Z report reference an employee so the tracking table can total them per person.
CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  phone       TEXT,                                          -- optional; used to dedupe an Excel import
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
-- §4 employee_stores — which stores an employee works at. Same shape and same rule as
-- supplier_stores: NO rows = shared with every store (what every employee was before this
-- existed); rows = visible and usable only in those stores. An employee can be linked to several
-- stores, in several companies (a delivery driver serving two branches, a bookkeeper for the group).
CREATE TABLE IF NOT EXISTS employee_stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  store_id    INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  UNIQUE (employee_id, store_id)
);
CREATE INDEX IF NOT EXISTS ix_employee_stores_employee ON employee_stores(employee_id);

-- z_expenses — drawer expense lines for a Z report (phase 2b). description_type is the "kind":
-- manual (ידני) / salary (שכר) / advance (מפרעה) / invoice (תשלום חשבונית).
CREATE TABLE IF NOT EXISTS z_expenses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  z_report_id      INTEGER NOT NULL REFERENCES z_reports(id) ON DELETE CASCADE,
  expense_date     TEXT,
  payer_name       TEXT,
  purpose          TEXT,             -- "עבור" (free text)
  description_type TEXT,             -- kind: manual / salary / advance / invoice
  employee_name    TEXT,
  employee_id      INTEGER REFERENCES employees(id),  -- salary/advance → which employee
  amount           INTEGER NOT NULL DEFAULT 0,
  invoice_id       INTEGER REFERENCES invoices(id),  -- optional: cash expense matched to an invoice
  image_path       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);

-- deposits — "הצהרה על הפקדה": a bank deposit declaration (bag number + amount), with a flag
-- marking whether it was actually deposited to the bank.
CREATE TABLE IF NOT EXISTS deposits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  z_report_id  INTEGER REFERENCES z_reports(id),  -- optional link to the Z this deposit was declared on
  deposit_date TEXT NOT NULL,
  bag_number   TEXT,
  amount       INTEGER NOT NULL DEFAULT 0,   -- agorot
  deposited    INTEGER NOT NULL DEFAULT 0,   -- 0/1 — הופקד לבנק
  matched_txn_id INTEGER REFERENCES bank_transactions(id),  -- bank line matched by bag=reference (recon)
  recon_diff   INTEGER,                       -- agorot: bank amount − declared (יתרה>0 / חוסר<0); NULL until reconciled
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);

-- z_closings — "סגירת Z": a register-closer's end-of-shift cash count. Denomination breakdown
-- (JSON), cash total, itemized expenses (JSON) + their total, and grand total (cash + expenses).
-- started_at/ended_at are Israel local time captured by the interface.
CREATE TABLE IF NOT EXISTS z_closings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_first TEXT NOT NULL,
  employee_last  TEXT NOT NULL,
  store_id       INTEGER REFERENCES stores(id),  -- which store this closing is for
  z_number       TEXT,                            -- מספר Z (required at entry)
  drawer_cash    INTEGER NOT NULL DEFAULT 0,      -- סה"כ מזומן מגירה (agorot, entered)
  started_at     TEXT,
  ended_at       TEXT,
  breakdown      TEXT,                          -- JSON { denom: count }
  total_cash     INTEGER NOT NULL DEFAULT 0,    -- agorot
  expenses       TEXT,                          -- JSON [{ desc, amount }]
  total_expenses INTEGER NOT NULL DEFAULT 0,    -- agorot
  grand_total    INTEGER NOT NULL DEFAULT 0,    -- agorot (cash + expenses)
  registers      TEXT,                          -- JSON [{first,last,register,storeId,breakdown,total}] — per-register cash balancing done before the Z
  employee_id    INTEGER REFERENCES employees(id),  -- who performed the count (from employees list)
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);

-- z_closing_expenses — itemized cash expenses of a register closing (סגירת Z), mirroring
-- z_expenses: kind (manual/salary/advance/invoice), date, payer/purpose, employee/invoice link.
CREATE TABLE IF NOT EXISTS z_closing_expenses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  closing_id       INTEGER NOT NULL REFERENCES z_closings(id) ON DELETE CASCADE,
  expense_date     TEXT,
  payer_name       TEXT,
  purpose          TEXT,             -- "עבור" (free text)
  description_type TEXT,             -- kind: manual / salary / advance / invoice
  employee_id      INTEGER REFERENCES employees(id),  -- salary/advance → which employee
  invoice_id       INTEGER REFERENCES invoices(id),   -- invoice → cash expense matched to an invoice
  amount           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_z_closing_expenses_closing ON z_closing_expenses(closing_id);
CREATE INDEX IF NOT EXISTS ix_z_closing_expenses_invoice ON z_closing_expenses(invoice_id);

-- sales_entries — manual register (Z) totals per store, for the profitability report (§7).
-- Purchases come automatically from invoices; sales are entered by hand here.
CREATE TABLE IF NOT EXISTS sales_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  sale_date  TEXT NOT NULL,                 -- the business day the Z total is for
  amount     INTEGER NOT NULL,              -- agorot (gross register sales)
  notes      TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_sales_store_date ON sales_entries(store_id, sale_date);

-- §4 audit_log ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER,
  timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  details     TEXT
);

-- Saved role templates: a named permission preset the owner can apply to a user in one click.
CREATE TABLE IF NOT EXISTS role_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  permissions TEXT,            -- JSON array of permission keys
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_role_templates_name ON role_templates(name);

-- products — קטלוג מוצרים מצטבר לפי ספק (נבנה מאישור חשבוניות סרוקות). last_cost הוא מחיר
-- היחידה האחרון שנקלט (אגורות, לפני מע"מ) יחד עם תאריך החשבונית שקבע אותו.
CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(id),
  name           TEXT NOT NULL,
  barcode        TEXT,                 -- 12-13 ספרות; ייחודי בתוך הספק כשקיים
  sku            TEXT,                 -- מק"ט הספק
  last_cost      INTEGER,              -- agorot per unit, before VAT
  last_cost_date TEXT,                 -- 'YYYY-MM-DD' of the invoice that set last_cost
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  updated_at     TEXT                  -- last edit; NULL until first updated
);
-- ברקוד הוא מפתח חזק בתוך ספק — ייחודי כשקיים.
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_supplier_barcode
  ON products(supplier_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_products_supplier_name ON products(supplier_id, name);

-- product_prices — היסטוריית מחירי קנייה למוצר (שורה לכל חשבונית שבה הופיע), לגרף מגמת מחיר.
CREATE TABLE IF NOT EXISTS product_prices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  invoice_id INTEGER REFERENCES invoices(id),   -- מאיזו חשבונית נלקח המחיר (nullable)
  price      INTEGER NOT NULL,                  -- agorot per unit, before VAT
  quantity   REAL,                              -- כמות בשורה שממנה נגזר המחיר
  price_date TEXT NOT NULL,                     -- 'YYYY-MM-DD' (תאריך החשבונית)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_product_prices_product_date
  ON product_prices(product_id, price_date);

-- invoice_lines — שורות הפריטים של חשבונית (מה שחולץ מהצילום ואושר על ידי המשתמש).
-- כל הסכומים באגורות לפני מע"מ; בחשבונית זיכוי line_total שלילי.
CREATE TABLE IF NOT EXISTS invoice_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id),   -- שיוך לקטלוג (nullable)
  line_no          INTEGER NOT NULL,
  name             TEXT NOT NULL,
  barcode          TEXT,
  sku              TEXT,
  quantity         REAL NOT NULL DEFAULT 1,           -- כמות כפי שמודפסת (לעיתים ארגזים/מארזים)
  unit_quantity    REAL,                              -- כ.בודד: מספר היחידות הבודדות בשורה
  unit_cost        INTEGER,                           -- agorot ליחידה בודדת לפני מע"מ; NULL אם לא ידוע
  unit_cost_source TEXT
                   CHECK (unit_cost_source IN ('extracted','computed','manual')),
  pack_cost        INTEGER,                           -- agorot לארגז/מארז כשהמחיר המודפס אינו ליחידה
  line_total       INTEGER NOT NULL                   -- agorot before VAT (negative for credit)
);
CREATE INDEX IF NOT EXISTS ix_invoice_lines_invoice ON invoice_lines(invoice_id);

-- invoice_drafts — טיוטת חשבונית סרוקה: התמונות שהועלו, תוצאת החילוץ של המודל והנתונים
-- המנורמלים, עד לאישור העובד. באישור נוצרת חשבונית (invoice_id) והסטטוס עובר ל-committed.
CREATE TABLE IF NOT EXISTS invoice_drafts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id              INTEGER NOT NULL REFERENCES stores(id),
  company_id            INTEGER NOT NULL REFERENCES companies(id),
  -- Optionally chosen on the capture screen BEFORE the photo is taken, so that supplier's
  -- learned profile ("הסקיל") can travel with the very first extraction rather than only on a
  -- re-run. Null means "we do not know yet" and the supplier is matched from the document.
  supplier_id           INTEGER REFERENCES suppliers(id),
  status                TEXT NOT NULL DEFAULT 'uploaded'
                        CHECK (status IN ('uploaded','processing','needs_review','committed','failed')),
  images                TEXT NOT NULL,   -- JSON array of storage refs, בסדר העמודים
  extraction            TEXT,            -- raw model JSON
  normalized            TEXT,            -- validated + edited JSON (incl. flags)
  error                 TEXT,            -- הודעת כשל ידידותית (status='failed')
  model                 TEXT,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  duration_ms           INTEGER,
  invoice_id            INTEGER REFERENCES invoices(id),  -- נקבע באישור
  processing_started_at TEXT,            -- לזיהוי עיבוד תקוע (stale guard)
  created_by            INTEGER NOT NULL REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  updated_at            TEXT
);
CREATE INDEX IF NOT EXISTS ix_invoice_drafts_status ON invoice_drafts(status);

-- master_catalog — קטלוג-על: כל מוצרי הסופר לפי יצרן, מיובא מקבצי המחירים הפומביים
-- (חוק שקיפות המחירים — שופרסל). מקור אמת לזהות מוצר (ברקוד → שם, יצרן, אריזה) בלבד;
-- retail_price הוא מחיר מדף לתצוגה — לעולם לא משמש לאימות מחירי קנייה.
CREATE TABLE IF NOT EXISTS master_catalog (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode           TEXT NOT NULL UNIQUE,      -- ItemCode (EAN אוניברסלי בלבד)
  name              TEXT NOT NULL,             -- ItemName
  sku               TEXT,                      -- מק"ט היצרן כשהקובץ מספק אותו (לרוב ריק)
  manufacturer_name TEXT,                      -- ManufacturerName ("תנובה", "טרה"...)
  manufacturer_norm TEXT,                      -- normalizeSupplierName(manufacturer_name)
  unit_qty          TEXT,                      -- UnitQty ("ליטר", "גרם"...)
  quantity          REAL,                      -- Quantity (תכולה)
  qty_in_package    REAL,                      -- QtyInPackage
  retail_price      INTEGER,                   -- agorot — מחיר מדף, תצוגה בלבד
  source_chain      TEXT NOT NULL DEFAULT 'shufersal',
  source_store      TEXT,
  imported_at       TEXT NOT NULL,             -- מועד ריצת הייבוא שעדכנה את השורה
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_master_catalog_manufacturer ON master_catalog(manufacturer_norm);

-- app_settings — app-wide key/value flags (entitlements/toggles), e.g. scan feature lock.
-- value is TEXT; callers coerce. Owner-managed from Settings.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
-- supplier_catalog — הקטלוג של הספק עצמו: מה שהספק מוכר לנו, מקובץ שהוא מסר.
-- להבדיל מ-master_catalog (קטלוג-על ציבורי לפי ברקוד), זה קטלוג פר-ספק, והוא מה שמאפשר לזהות
-- מוצר בחשבונית שאין בה ברקוד כלל (מוצרי איכות קנדים, פיליפ מוריס) או שיש בה רק מק"ט פנימי
-- (גלוברנדס, דובק). מוצר = שתי שורות: קופסה ופאקט, עם אותו name_norm ואותו מק"ט, ברקוד שונה.
CREATE TABLE IF NOT EXISTS supplier_catalog (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  barcode         TEXT NOT NULL,             -- ברקוד מלא (GTIN, ספרת ביקורת נבדקה בייבוא)
  name            TEXT NOT NULL,             -- שם מוצר כפי שהוא בקטלוג ("פאקט מרלבורו אדום")
  name_norm       TEXT NOT NULL,             -- השם בלי מילת האריזה — מפתח הזיהוי, משותף לזוג
  sku             TEXT,                      -- מק"ט/פריט של הספק (גלוברנדס: 4 ספרות, משותף לזוג)
  pack_type       TEXT,                      -- 'קופסה' / 'פאקט'
  pack_units      INTEGER,                   -- יח' אריזה: 1 / 5 / 10
  brand           TEXT,                      -- מותג / משפחה
  category        TEXT,                      -- 'סיגריות' / 'טבק לגלגול' / ...
  linked_barcode  TEXT,                      -- הברקוד של האריזה השנייה של אותו מוצר
  imported_at     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  UNIQUE (supplier_id, barcode)
);
CREATE INDEX IF NOT EXISTS ix_supplier_catalog_supplier ON supplier_catalog(supplier_id);
CREATE INDEX IF NOT EXISTS ix_supplier_catalog_name ON supplier_catalog(supplier_id, name_norm);
CREATE INDEX IF NOT EXISTS ix_supplier_catalog_sku ON supplier_catalog(supplier_id, sku);

-- §4 salary_payments — how each employee's WAGE was actually paid. Distinct from a supplier
-- payment (no supplier, no invoice): who, by what means, its identifier, the date it is FOR, and
-- how much. Entered on the עובדים ומשכורות page, per store.
--
-- The interesting case is a wage CHECK the employee cashes at the till instead of at the bank
-- ("פורט את הצק"): the money leaves the register, so it shows up as a cash expense on a Z closing,
-- and the check itself must be voided or it will look outstanding forever. cash_expense_id is that
-- match, and payment_id links the row to the actual check when one was issued through /payments.
CREATE TABLE IF NOT EXISTS salary_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        INTEGER NOT NULL REFERENCES stores(id),
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  method          TEXT NOT NULL DEFAULT 'check'
                  CHECK (method IN ('check','cash','transfer','batch')),
  reference       TEXT,                                    -- מס' אסמכתה / מספר צ'ק
  due_date        TEXT NOT NULL,                           -- "לתאריך" — ISO YYYY-MM-DD
  amount          INTEGER NOT NULL,                        -- agorot
  -- The wage check was cashed from the register. Set together with cash_expense_id when the
  -- owner matches it to the Z-closing cash expense that paid it out.
  cashed          INTEGER NOT NULL DEFAULT 0,
  cash_expense_id INTEGER REFERENCES z_closing_expenses(id) ON DELETE SET NULL,
  payment_id      INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_salary_payments_store ON salary_payments(store_id, due_date);

-- §4 bank_transfers — "העברות בנקאיות": the REQUEST to make a transfer, raised in the app BEFORE
-- anyone touches the bank, and the audit trail that follows it.
--
-- WHY A REQUEST AND NOT A RECORD: software cannot stop somebody logging into the bank and moving
-- money. What it can do is make an unrecorded transfer impossible to HIDE. So the flow is inverted
-- — the secretary raises the request here, the owner approves it here, and only then is the
-- transfer made; every outgoing movement the bank later reports that has no request behind it is
-- an alarm (services/transfers.js#untrackedTransfers).
--
-- Almost nothing is typed. The invoices are TICKED, and the amount, supplier, store and bank
-- account are all derived from them — so the request cannot be for an amount nobody owes, and the
-- owner's approval is of a specific payee and a specific sum rather than of a screenshot.
--
-- opened_at is the enforcement anchor: it is stamped in Israel time when the request is raised, and
-- compared against the bank's own date for the movement. A request created AFTER the money already
-- moved is back-filling, and says so on the page.
CREATE TABLE IF NOT EXISTS bank_transfers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        INTEGER NOT NULL REFERENCES stores(id),
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  supplier_id     INTEGER REFERENCES suppliers(id),
  amount          INTEGER NOT NULL,                    -- agorot, derived from the linked invoices
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','executed','rejected','cancelled')),
  opened_at       TEXT NOT NULL,                       -- Israel time the request was raised
  opened_by       INTEGER NOT NULL REFERENCES users(id),
  approved_at     TEXT,
  approved_by     INTEGER REFERENCES users(id),
  rejected_reason TEXT,
  executed_at     TEXT,                                -- when the transfer was actually made
  reference       TEXT,                                -- the bank's אסמכתה — the only typed field
  payment_id      INTEGER REFERENCES payments(id),
  -- What was approved, fingerprinted. An approval is of a SPECIFIC payee, sum and destination —
  -- if any of them changes afterwards the approval is no longer about the thing being released,
  -- so it is void rather than silently carried over. See services/transfers.js#substanceOf.
  approved_fingerprint TEXT,
  alerted         TEXT,                                -- last alert kind sent, so a sweep stays quiet     -- the payments row created on execute
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_bank_transfers_store ON bank_transfers(store_id, status);

-- Which unpaid invoices this transfer pays. The amount is their sum; nothing is typed.
CREATE TABLE IF NOT EXISTS bank_transfer_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id INTEGER NOT NULL REFERENCES bank_transfers(id) ON DELETE CASCADE,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id),
  UNIQUE (transfer_id, invoice_id)
);

-- §4 פרטי בנק של ספק — where a transfer to this supplier is allowed to go.
--
-- THE FRAUD THIS EXISTS FOR: the dangerous transfer is not one for a fake invoice. It is a REAL
-- invoice, a real amount, correctly approved — paid into an account that was quietly changed. An
-- email from "the supplier" saying their bank details changed is the most common way a business
-- this size loses money, and nothing about the invoice looks wrong. So the destination is held
-- here, changing it is an owner-only act, every change is kept, and a transfer to a supplier whose
-- details changed recently says so at the moment of approval.
CREATE TABLE IF NOT EXISTS supplier_bank_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  old_bank      TEXT, old_branch TEXT, old_account TEXT, old_holder TEXT,
  new_bank      TEXT, new_branch TEXT, new_account TEXT, new_holder TEXT,
  store_id      INTEGER REFERENCES stores(id),   -- לאיזו חנות שייך החשבון שהשתנה (NULL = ברירת מחדל)
  old_extra     TEXT, new_extra TEXT,               -- JSON: קוד בנק / ח״פ מוטב / IBAN
  changed_at    TEXT NOT NULL,
  changed_by    INTEGER REFERENCES users(id),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS ix_supplier_bank_changes ON supplier_bank_changes(supplier_id, changed_at);

-- §5 חשבונות הבנק של הספק — שורה לכל (ספק, חנות). זו הכתובת שאליה מותר להעביר כסף.
--
-- למה טבלה ולא ארבע עמודות על `suppliers` (מה שהיה כאן קודם):
--   • ספק אחד יכול לקבל תשלום לחשבון שונה לכל חברה/חנות. עמודה אחת מכריחה בחירה שגויה.
--   • הכתובת צריכה קוד בנק, מזהה מוטב ו-IBAN — שדות שמאפשרים אימות, לא רק תצוגה.
--   • כל שורה נושאת מתי אומתה טלפונית ועל ידי מי. זו ההגנה האמיתית מפני "החלפנו חשבון" במייל.
--
-- store_id NULL = חשבון ברירת המחדל של הספק, תקף לכל חנות שאין לה חשבון משלה. חנות עם שורה
-- משלה גוברת. הבחירה הזו נעשית ב-services/suppliers.js#supplierBankFor — מקום אחד, כדי
-- שהטביעה של ההעברה (services/transfers.js#substanceOf) והמסך יראו בדיוק את אותו חשבון.
CREATE TABLE IF NOT EXISTS supplier_bank_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  store_id      INTEGER REFERENCES stores(id) ON DELETE CASCADE,  -- NULL = ברירת מחדל
  bank_code     TEXT,     -- קוד בנק דו-ספרתי (lib/banks.js). זה מה שמזהה בנק, לא השם.
  bank_name     TEXT,     -- נגזר מהקוד; נשמר כדי שתצוגה והיסטוריה לא ישתנו אם הרשימה תתעדכן
  bank_branch   TEXT,     -- עד 3 ספרות
  bank_account  TEXT,
  bank_holder   TEXT,     -- שם בעל החשבון — חייב להתאים לספק, אחרת זה דגל אדום
  holder_tax_id TEXT,     -- ח״פ / ת״ז של המוטב, עם ספרת ביקורת
  iban          TEXT,
  verified_at   TEXT,     -- אומת טלפונית מול הספק — התיעוד שמבדיל בין "נרשם" ל"נבדק"
  verified_by   INTEGER REFERENCES users(id),
  verified_note TEXT,
  updated_at    TEXT,
  updated_by    INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_supplier_bank_accounts ON supplier_bank_accounts(supplier_id, store_id);
-- שורה אחת לכל (ספק, חנות), ושורת ברירת-מחדל אחת. UNIQUE רגיל לא מספיק כי NULL אינו שווה
-- לעצמו — אפשר היה ליצור שתי ברירות מחדל ולא לדעת לאיזו מהן הכסף הולך. COALESCE(store_id, 0)
-- הופך את "אין חנות" לערך אחד ממשי, ולכן אינדקס אחד מבטא את שני הכללים.
-- 🔴 לא להחליף באינדקס ייחודי חלקי (`... ON (supplier_id) WHERE store_id IS NULL`): pg-mem
-- מתייחס אליו כאילו הוא מלא ומחזיר שורה אחת בלבד ל-`WHERE supplier_id = ?` — החשבון של החנות
-- פשוט נעלם, בשקט, רק תחת TEST_PG.
CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_bank_account
  ON supplier_bank_accounts(supplier_id, COALESCE(store_id, 0));

-- §5 מפרעות והלוואות לעובד, והחזריהן.
--
-- הרובריקה הישנה ידעה לקרוא רק שורות מפרעה שהוזנו בדוח Z — כלומר כסף שיצא מהקופה. אבל מפרעה
-- שניתנה בהעברה, בצ׳ק או מהכיס לא הופיעה בשום מקום, והחזר לא היה לו איפה להירשם בכלל: הסכום
-- פשוט נשאר שם לנצח כאילו העובד עדיין חייב אותו.
--
-- לכן זה הספר היחיד של "כמה העובד חייב". מפרעה שכן יצאה מ-Z **משוקפת לכאן** לפי `z_expense_id`
-- (services/employees.js#syncZAdvances) — הסכום שלה נשאר בבעלות ה-Z ואי אפשר לערוך אותו מכאן,
-- אבל אפשר לרשום עליה החזרים בדיוק כמו על כל מפרעה אחרת. יתרה = סכום פחות סך ההחזרים.
CREATE TABLE IF NOT EXISTS employee_advances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  kind          TEXT NOT NULL DEFAULT 'advance' CHECK (kind IN ('advance','loan')),
  issued_date   TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  method        TEXT,      -- cash / check / transfer / register
  reference     TEXT,      -- מספר צ׳ק / אסמכתה
  note          TEXT,
  -- שורת ה-Z שממנה שוקפה השורה. NULL = נרשמה ידנית כאן. UNIQUE כדי שסנכרון חוזר לא יכפיל.
  z_expense_id  INTEGER UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  created_by    INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_employee_advances ON employee_advances(employee_id, issued_date);
CREATE INDEX IF NOT EXISTS ix_employee_advances_store ON employee_advances(store_id);

-- החזר אחד. מפרעה מוחזרת בדרך כלל בכמה פעימות מהשכר, ולכן זו טבלה ולא עמודת "הוחזר".
CREATE TABLE IF NOT EXISTS employee_advance_repayments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  advance_id        INTEGER NOT NULL REFERENCES employee_advances(id) ON DELETE CASCADE,
  repaid_date       TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  source            TEXT NOT NULL DEFAULT 'salary' CHECK (source IN ('salary','cash','other')),
  salary_payment_id INTEGER REFERENCES salary_payments(id),  -- מאיזה תשלום שכר נוכה
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  created_by        INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_advance_repayments ON employee_advance_repayments(advance_id, repaid_date);


