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
  contact_phone  TEXT,
  payment_method TEXT,   -- העברה / צק / מזומן / אשראי / הו"ק (transfer/check/cash/credit/standing_order)
  payment_terms  TEXT,   -- מיידי / דחוי 14 / 30 / 45 / טקסט חופשי
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