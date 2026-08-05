// Lightweight, idempotent migrations for databases created before a schema change.
// Called on every getDb() after the schema is applied. Fresh databases already match the
// latest schema, so each migration is a no-op there.

/**
 * Bring an existing database up to date.
 * @param {import('better-sqlite3').Database} db
 */
export function migrate(db) {
  migratePaymentsMethods(db);
  migrateSupplierContacts(db);
  migrateUserAuth(db);
  migrateBankBalance(db);
  migrateUserCompanies(db);
  migrateDeposits(db);
  migrateZExtras(db);
}

// Adds z_expenses.purpose ("עבור") and z_reports.image_path (Z-slip scan) to older databases.
function migrateZExtras(db) {
  const has = (t) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (has('z_expenses')) {
    const cols = db.prepare('PRAGMA table_info(z_expenses)').all().map((c) => c.name);
    if (!cols.includes('purpose')) db.exec('ALTER TABLE z_expenses ADD COLUMN purpose TEXT;');
  }
  if (has('z_reports')) {
    const cols = db.prepare('PRAGMA table_info(z_reports)').all().map((c) => c.name);
    if (!cols.includes('image_path')) db.exec('ALTER TABLE z_reports ADD COLUMN image_path TEXT;');
  }
  // Cash expense → invoice link; deposit → Z link + bank reconciliation (bag=reference).
  if (has('z_expenses')) {
    const cols = db.prepare('PRAGMA table_info(z_expenses)').all().map((c) => c.name);
    if (!cols.includes('invoice_id')) db.exec('ALTER TABLE z_expenses ADD COLUMN invoice_id INTEGER REFERENCES invoices(id);');
  }
  if (has('deposits')) {
    const cols = db.prepare('PRAGMA table_info(deposits)').all().map((c) => c.name);
    if (!cols.includes('z_report_id')) db.exec('ALTER TABLE deposits ADD COLUMN z_report_id INTEGER REFERENCES z_reports(id);');
    if (!cols.includes('matched_txn_id')) db.exec('ALTER TABLE deposits ADD COLUMN matched_txn_id INTEGER REFERENCES bank_transactions(id);');
    if (!cols.includes('recon_diff')) db.exec('ALTER TABLE deposits ADD COLUMN recon_diff INTEGER;');
  }
}

// Adds the deposits table (bank deposit declarations) to older databases.
function migrateDeposits(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS deposits (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     INTEGER NOT NULL REFERENCES stores(id),
    deposit_date TEXT NOT NULL,
    bag_number   TEXT,
    amount       INTEGER NOT NULL DEFAULT 0,
    deposited    INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
  );`);
}

// Adds users.phone + the user_companies table (per-user company access) to older databases.
function migrateUserCompanies(db) {
  const hasUsers = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (hasUsers) {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!cols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT;');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS user_companies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    UNIQUE (user_id, company_id)
  );`);
}

// Adds balance_after to bank_transactions for older databases.
function migrateBankBalance(db) {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bank_transactions'")
    .get();
  if (!hasTable) return;
  const cols = db.prepare('PRAGMA table_info(bank_transactions)').all().map((c) => c.name);
  if (!cols.includes('balance_after')) db.exec('ALTER TABLE bank_transactions ADD COLUMN balance_after INTEGER;');
}

// Adds login columns (username / password_hash) to users for older databases.
function migrateUserAuth(db) {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasTable) return;
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('username')) db.exec('ALTER TABLE users ADD COLUMN username TEXT;');
  if (!cols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT;');
  if (!cols.includes('label')) db.exec('ALTER TABLE users ADD COLUMN label TEXT;');
  if (!cols.includes('permissions')) db.exec('ALTER TABLE users ADD COLUMN permissions TEXT;');
  if (!cols.includes('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT;');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users(username) WHERE username IS NOT NULL;');
}

// Adds supplier contact columns (phone/email/contact_name/contact_phone) to older databases.
function migrateSupplierContacts(db) {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suppliers'")
    .get();
  if (!hasTable) return;
  const cols = db.prepare('PRAGMA table_info(suppliers)').all().map((c) => c.name);
  for (const col of ['phone', 'email', 'contact_name', 'contact_phone', 'payment_method', 'payment_terms']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE suppliers ADD COLUMN ${col} TEXT;`);
  }
}

// Adds the payment-method columns (method/reference/payer_name/card_last4/batch_number) and
// relaxes check_number to nullable. Because SQLite can't drop a NOT NULL in place, we rebuild
// the table (the documented safe procedure) when the `method` column is missing.
function migratePaymentsMethods(db) {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payments'")
    .get();
  if (!hasTable) return; // schema not applied yet
  const cols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
  if (cols.includes('method')) return; // already migrated

  db.pragma('foreign_keys = OFF'); // must be toggled outside a transaction
  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE payments_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
        method          TEXT NOT NULL DEFAULT 'check'
                        CHECK (method IN ('check','cash','credit','transfer','batch')),
        check_number    TEXT,
        reference       TEXT,
        payer_name      TEXT,
        card_last4      TEXT,
        batch_number    TEXT,
        payment_date    TEXT NOT NULL,
        amount          INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'issued'
                        CHECK (status IN ('issued','cleared','voided')),
        cleared_date    TEXT,
        created_by      INTEGER NOT NULL REFERENCES users(id),
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
      );`);
    db.exec(`
      INSERT INTO payments_new
        (id, bank_account_id, method, check_number, payment_date, amount, status, cleared_date, created_by, created_at)
      SELECT id, bank_account_id, 'check', check_number, payment_date, amount, status, cleared_date, created_by,
             COALESCE(created_at, strftime('%Y-%m-%d %H:%M:%S','now'))
        FROM payments;`);
    db.exec('DROP TABLE payments;');
    db.exec('ALTER TABLE payments_new RENAME TO payments;');
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_account_check
         ON payments(bank_account_id, check_number) WHERE check_number IS NOT NULL;`,
    );
  });
  run();
  db.pragma('foreign_keys = ON');
}
