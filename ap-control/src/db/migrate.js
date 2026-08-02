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
  migrateTransferColumns(db);
}

// Adds proof-image / bank-verification columns to bank_transfers for older databases that
// created the table before these columns existed.
function migrateTransferColumns(db) {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bank_transfers'")
    .get();
  if (!hasTable) return;
  const cols = db.prepare('PRAGMA table_info(bank_transfers)').all().map((c) => c.name);
  if (!cols.includes('image_path')) db.exec('ALTER TABLE bank_transfers ADD COLUMN image_path TEXT;');
  if (!cols.includes('verified')) db.exec('ALTER TABLE bank_transfers ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;');
  if (!cols.includes('verified_at')) db.exec('ALTER TABLE bank_transfers ADD COLUMN verified_at TEXT;');
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
  for (const col of ['phone', 'email', 'contact_name', 'contact_phone']) {
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
