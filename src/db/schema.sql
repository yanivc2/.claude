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
  display_name   TEXT NOT NULL
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
  notes       TEXT
);

-- §4 users ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','secretary'))
);

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
                  CHECK (method IN ('check','cash','credit','transfer','batch')),
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
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
-- A check number is unique within a bank account (checks only).
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_account_check
  ON payments(bank_account_id, check_number) WHERE check_number IS NOT NULL;

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
  source             TEXT NOT NULL DEFAULT 'scraper',
  matched_payment_id INTEGER REFERENCES payments(id)
);

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
  drawer_z         INTEGER NOT NULL DEFAULT 0,   -- מגירה Z (register printout; reconciled vs cash+check+credit)
  -- הפקדות (phase 2c)
  deposit_amount   INTEGER,
  deposit_bag      TEXT,
  deposit_breakdown TEXT,                         -- JSON of bill counts
  -- כרטיסי אשראי (phase 2d)
  cc_kal INTEGER, cc_isracard INTEGER, cc_diners INTEGER, cc_amex INTEGER,
  cc_general INTEGER, cc_tourist INTEGER, cc_total INTEGER,
  status           TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','unmatched')),
  reconcile_notes  TEXT,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_zreports_store_date ON z_reports(store_id, z_date);

-- z_expenses — drawer expense lines for a Z report (phase 2b).
CREATE TABLE IF NOT EXISTS z_expenses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  z_report_id      INTEGER NOT NULL REFERENCES z_reports(id) ON DELETE CASCADE,
  expense_date     TEXT,
  payer_name       TEXT,
  description_type TEXT,
  employee_name    TEXT,
  amount           INTEGER NOT NULL DEFAULT 0,
  image_path       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);

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
