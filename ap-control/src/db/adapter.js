// Async dual-backend data-access layer.
//
// Backend is chosen by environment:
//   * DATABASE_URL present -> PostgreSQL (Neon / any Postgres), via node-postgres.
//   * otherwise            -> SQLite (better-sqlite3) at config.dbPath — the local/office mode.
//
// All application SQL is written with '?' placeholders (SQLite-native); for Postgres the
// adapter rewrites them to $1,$2,… A single `Executor` interface (one/many/run) is used by
// every service, so call sites are backend-agnostic. Transactions run via tx().
//
// Money columns are BIGINT in Postgres; node-postgres returns int8 as strings, so we register
// an int8 parser that returns Number (agorot totals stay well within Number.MAX_SAFE_INTEGER).

/** Portable 'YYYY-MM-DD HH:MM:SS' UTC timestamp (replaces SQLite strftime('now')). */
export function nowTs() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// ---- placeholder + INSERT helpers -------------------------------------------------------

function toPgText(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${(i += 1)}`);
}

function isInsertWantingId(sql) {
  return /^\s*INSERT\b/i.test(sql) && !/RETURNING/i.test(sql) && !/ON\s+CONFLICT/i.test(sql);
}

// ---- runners: turn a backend handle into a uniform async query(sql, params, opts) --------
// Returns { rows, rowCount, lastInsertRowid }.

function pgRunner(handle) {
  // handle is a node-postgres Pool or Client (both expose .query)
  return {
    async query(sql, params = [], opts = {}) {
      let text = toPgText(sql);
      if (opts.wantId && isInsertWantingId(sql)) text += ' RETURNING id';
      const res = await handle.query(text, params);
      return {
        rows: res.rows,
        rowCount: res.rowCount,
        lastInsertRowid: res.rows && res.rows[0] ? res.rows[0].id : undefined,
      };
    },
  };
}

function sqliteRunner(handle) {
  // handle is a better-sqlite3 Database (sync); wrapped to look async.
  return {
    async query(sql, params = []) {
      const stmt = handle.prepare(sql);
      if (stmt.reader) {
        return { rows: stmt.all(...params), rowCount: undefined, lastInsertRowid: undefined };
      }
      const info = stmt.run(...params);
      return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
  };
}

/** Wrap a runner in the Executor interface used across services. */
function makeExecutor(runner) {
  return {
    async one(sql, params = []) {
      const { rows } = await runner.query(sql, params);
      return rows[0];
    },
    async many(sql, params = []) {
      const { rows } = await runner.query(sql, params);
      return rows;
    },
    async run(sql, params = []) {
      const r = await runner.query(sql, params, { wantId: true });
      return { changes: r.rowCount, lastInsertRowid: r.lastInsertRowid };
    },
    async exec(sql) {
      await runner.query(sql, []);
    },
  };
}

// ---- backend wiring ---------------------------------------------------------------------

let backend = null; // 'pg' | 'sqlite'
let pgPool = null;
let sqliteDb = null;
let defaultExecutor = null;

/**
 * Initialize the backend. For tests, pass an explicit { pgPool } (e.g. pg-mem) or { sqliteDb }.
 * In production, called with no args — reads env/config.
 */
export async function initBackend(opts = {}) {
  if (opts.pgPool) {
    backend = 'pg';
    pgPool = opts.pgPool;
    defaultExecutor = makeExecutor(pgRunner(pgPool));
  } else if (opts.sqliteDb) {
    backend = 'sqlite';
    sqliteDb = opts.sqliteDb;
    defaultExecutor = makeExecutor(sqliteRunner(sqliteDb));
  } else if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8 -> Number
    pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric (SUM of bigint) -> Number
    pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    });
    backend = 'pg';
    defaultExecutor = makeExecutor(pgRunner(pgPool));
  } else {
    const Database = (await import('better-sqlite3')).default;
    const { config } = await import('../config.js');
    sqliteDb = new Database(config.dbPath);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    backend = 'sqlite';
    defaultExecutor = makeExecutor(sqliteRunner(sqliteDb));
  }
  return defaultExecutor;
}

export function getExecutor() {
  if (!defaultExecutor) throw new Error('DB not initialized — call initBackend() first');
  return defaultExecutor;
}

export function getBackend() {
  return backend;
}

/** The raw better-sqlite3 handle (SQLite backend only) — used by SQLite-specific migrations. */
export function getRawSqlite() {
  return sqliteDb;
}

/** Run a multi-statement SQL script (schema load). Handles ';'-separated statements. */
export async function execScript(sql) {
  if (backend === 'pg') {
    await pgPool.query(sql); // pg simple-query protocol runs multiple statements
  } else {
    sqliteDb.exec(sql);
  }
}

/**
 * Run fn inside a transaction. fn receives a transaction-scoped Executor and must use it for
 * all its queries. Commits on success, rolls back on throw.
 */
export async function tx(fn) {
  if (backend === 'pg') {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(makeExecutor(pgRunner(client)));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  // sqlite: single connection, manual transaction control
  sqliteDb.exec('BEGIN');
  try {
    const out = await fn(defaultExecutor);
    sqliteDb.exec('COMMIT');
    return out;
  } catch (err) {
    sqliteDb.exec('ROLLBACK');
    throw err;
  }
}
