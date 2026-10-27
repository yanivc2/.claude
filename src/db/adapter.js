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

// Neon suspends an idle compute and terminates its connections (FATAL 57P01 "terminating
// connection due to administrator command"). A frozen serverless instance wakes holding such a
// dead pooled connection; the first statement sent on it fails with 57P01. The server never ran
// that statement (a statement cut by 57P01 is aborted, never committed), so it is safe to resend
// it once on a fresh connection.
export function isDeadConnection(err) {
  return !!err && err.code === '57P01';
}

function pgRunner(handle, { retryDead = false } = {}) {
  // handle is a node-postgres Pool or Client (both expose .query). Only a Pool may retry: a
  // Client inside tx() is pinned to one connection, and its transaction is gone with it.
  return {
    async query(sql, params = [], opts = {}) {
      let text = toPgText(sql);
      if (opts.wantId && isInsertWantingId(sql)) text += ' RETURNING id';
      let res;
      try {
        res = await handle.query(text, params);
      } catch (err) {
        if (!retryDead || !isDeadConnection(err)) throw err;
        res = await handle.query(text, params);
      }
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

// Without an 'error' listener, a pooled connection that dies while idle (Neon suspend) is an
// uncaught exception that kills the whole process — and the request in flight with it (seen in
// production on /login and /ingest/bank-agent/claim). pg-pool has already discarded that client
// by the time it emits, so logging is all that is left to do.
function guardPool(pool) {
  if (pool && typeof pool.on === 'function') {
    pool.on('error', (err) => console.warn('[db] idle connection dropped:', err && err.message));
  }
  return pool;
}

/**
 * Initialize the backend. For tests, pass an explicit { pgPool } (e.g. pg-mem) or { sqliteDb }.
 * In production, called with no args — reads env/config.
 */
export async function initBackend(opts = {}) {
  if (opts.pgPool) {
    backend = 'pg';
    pgPool = guardPool(opts.pgPool);
    defaultExecutor = makeExecutor(pgRunner(pgPool, { retryDead: true }));
  } else if (opts.sqliteDb) {
    backend = 'sqlite';
    sqliteDb = opts.sqliteDb;
    defaultExecutor = makeExecutor(sqliteRunner(sqliteDb));
  } else if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8 -> Number
    pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric (SUM of bigint) -> Number
    pgPool = guardPool(new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    }));
    backend = 'pg';
    defaultExecutor = makeExecutor(pgRunner(pgPool, { retryDead: true }));
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

// Split a schema script into individual statements. Our schema files use no dollar-quoted
// bodies and no ';' inside string literals, so stripping line comments + splitting on ';' is safe.
function splitStatements(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Run a schema script statement-by-statement. With { tolerant: true } (the on-demand upgrade of an
 * existing DB) a statement that fails is logged and skipped so the remaining idempotent migrations
 * still apply — crucially, on Postgres `pgPool.query(multiStatement)` runs as ONE implicit
 * transaction, so a single bad statement would otherwise roll back every ADD COLUMN in the file.
 * @returns {Promise<Array<{statement:string, message:string}>>} the failures (empty if all applied)
 */
export async function execScriptEach(sql, { tolerant = false } = {}) {
  const failures = [];
  for (const stmt of splitStatements(sql)) {
    try {
      if (backend === 'pg') await pgPool.query(stmt);
      else sqliteDb.exec(stmt);
    } catch (err) {
      if (!tolerant) throw err;
      failures.push({ statement: stmt.replace(/\s+/g, ' ').slice(0, 120), message: err.message });
      // eslint-disable-next-line no-console
      console.error(`[upgrade] skipped failing statement: ${err.message}`);
    }
  }
  return failures;
}

/**
 * Run fn inside a transaction. fn receives a transaction-scoped Executor and must use it for
 * all its queries. Commits on success, rolls back on throw.
 */
export async function tx(fn) {
  if (backend === 'pg') {
    for (let attempt = 1; ; attempt += 1) {
      const client = await pgPool.connect();
      // A checked-out client has no pool listener: if its connection dies between statements,
      // the 'error' would be uncaught and kill the process. The failing statement reports it.
      const onError = () => {};
      if (typeof client.on === 'function') client.on('error', onError);
      let broken = null;
      try {
        try {
          await client.query('BEGIN');
        } catch (err) {
          // Nothing ran yet — a dead pooled connection is safe to swap for a fresh one, once.
          if (attempt === 1 && isDeadConnection(err)) { broken = err; continue; }
          throw err;
        }
        const out = await fn(makeExecutor(pgRunner(client)));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        if (isDeadConnection(err)) broken = err;
        else await client.query('ROLLBACK').catch((e) => { broken = e; });
        throw err;
      } finally {
        if (typeof client.removeListener === 'function') client.removeListener('error', onError);
        client.release(broken || undefined);
      }
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
