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
  notes       TEXT,
  -- § priority 3: supplier contact details + bookkeeping contact
  phone          TEXT,
  email          TEXT,
  contact_name   TEXT,   -- accounting/bookkeeping contact person
  contact_phone  TEXT
);

-- §4 users ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','secretary')),
  username      TEXT,           -- login handle (unique when set)
  email         TEXT,           -- for password-reset by email
  label         TEXT,           -- optional display role name (e.g. "מנהל")
  permissions   TEXT,           -- JSON array of granted permission keys (non-owner)
  password_hash TEXT            -- scrypt hash; null until a password is set
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users(username) WHERE username IS NOT NULL;

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
  balance_after      INTEGER,                                  -- agorot; running balance if the export provides it
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

-- bank_transfers — scheduled/executed bank transfers (העברות בנקאיות, ROADMAP §D).
-- A transfer is control over money that leaves an account WITHOUT a physical check: it is
-- scheduled, must carry proof (an אסמכתא reference), is approved by the owner, and is then
-- reconciled to an invoice (or flagged as having none). `reference` matches the bank statement
-- line (like payments.reference) for verification against the bank feed.
CREATE TABLE IF NOT EXISTS bank_transfers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
  payee           TEXT NOT NULL,                            -- מקבל ההעברה
  amount          INTEGER NOT NULL,                         -- agorot
  transfer_date   TEXT NOT NULL,                            -- planned/execution date 'YYYY-MM-DD'
  reference       TEXT,                                     -- אסמכתא (matches bank statement)
  recurrence      TEXT NOT NULL DEFAULT 'once'
                  CHECK (recurrence IN ('once','monthly')),
  status          TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','executed','cancelled')),
  proof_approved  INTEGER NOT NULL DEFAULT 0,               -- 0/1 — owner approved the אסמכתא (R6-style)
  invoice_id      INTEGER REFERENCES invoices(id),          -- matched invoice (nullable)
  match_type      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (match_type IN ('invoice','none','pending')),
  match_note      TEXT,                                     -- explanation for 'none' / 'pending'
  cancel_reason   TEXT,
  executed_at     TEXT,
  image_path      TEXT,                                     -- proof (אסמכתא/חשבונית) image ref
  verified        INTEGER NOT NULL DEFAULT 0,               -- 0/1 — reconciled against the bank statement
  verified_at     TEXT,
  notes           TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_bank_transfers_status ON bank_transfers(status, transfer_date);

-- salaries — employee wage payments (משכורות, ROADMAP §D). Mirrors the payments table shape
-- (method + reference + amount + date) with an employee name and a free-text note. Kept
-- separate from `payments` because these are NOT invoice-backed and must not enter the
-- accounts-payable control flow (R1/R5).
CREATE TABLE IF NOT EXISTS salaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_name   TEXT NOT NULL,
  bank_account_id INTEGER REFERENCES bank_accounts(id),      -- account paid from (null for cash)
  method          TEXT NOT NULL DEFAULT 'transfer'
                  CHECK (method IN ('check','transfer','cash')),
  reference       TEXT,                                       -- check number / transfer אסמכתא
  amount          INTEGER NOT NULL,                           -- agorot
  pay_date        TEXT NOT NULL,
  period          TEXT,                                       -- e.g. '2026-07' (the salary month)
  notes           TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_salaries_date ON salaries(pay_date);

-- employees — pension-file compliance tracking (מעקב פנסיה, ROADMAP §D via user spec).
-- NOT a payroll/pension calculation — it tracks two legal duties: opening the pension file on
-- time after hiring, and sending the release notice (טופס 161) to the fund on termination.
CREATE TABLE IF NOT EXISTS employees (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  company_id          INTEGER REFERENCES companies(id),
  store_id            INTEGER REFERENCES stores(id),
  start_date          TEXT NOT NULL,                        -- hire date 'YYYY-MM-DD'
  prior_pension       INTEGER NOT NULL DEFAULT 0,           -- had an active fund before hire → shorter deadline
  pension_opened      INTEGER NOT NULL DEFAULT 0,           -- 0/1
  pension_opened_date TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','terminated')),
  termination_date    TEXT,
  termination_reason  TEXT CHECK (termination_reason IS NULL OR termination_reason IN ('resigned','dismissed')),
  release_sent        INTEGER NOT NULL DEFAULT 0,           -- release/161 notice sent to the fund
  release_sent_date   TEXT,
  notes               TEXT,
  created_by          INTEGER NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);
CREATE INDEX IF NOT EXISTS ix_employees_status ON employees(status);

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
