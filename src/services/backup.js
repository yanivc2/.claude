import { getExecutor, tx, getBackend } from '../db/adapter.js';
import { del as delStored } from '../lib/storage.js';
import { RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

// Full logical backup + a "start fresh" reset for go-live. Both are owner-only (enforced at the
// route). The backup is a complete JSON snapshot of every table; the reset clears transactional
// data (and its Blob images) while keeping the setup (companies/stores/bank accounts/users).

// Every table, setup first. Used for the export.
const ALL_TABLES = [
  'companies', 'stores', 'bank_accounts', 'users', 'user_companies', 'role_templates',
  'suppliers', 'invoices', 'payments', 'payment_lines', 'bank_transactions',
  'invoice_ocr', 'z_reports', 'z_expenses', 'deposits', 'sales_entries',
  'calendar_events', 'change_requests', 'password_resets', 'audit_log',
];

// Transactional tables to wipe on reset, in FK-safe (child-before-parent) order. `suppliers`
// is appended only when the caller opts in (it is referenced by invoices, so it must come after).
const RESET_ORDER = [
  'payment_lines', 'bank_transactions', 'invoice_ocr', 'z_expenses',
  'payments', 'invoices', 'z_reports', 'deposits', 'sales_entries',
  'calendar_events', 'change_requests', 'password_resets', 'audit_log',
];

// Tables that are preserved by a reset (the business setup) — surfaced to the UI.
export const RESET_KEEPS = ['companies', 'stores', 'bank_accounts', 'users', 'user_companies', 'role_templates'];

// Insert order for a restore: parents before children (satisfies every FK). The wipe runs in
// the reverse order (children first).
const RESTORE_ORDER = [
  'companies', 'stores', 'bank_accounts', 'users', 'user_companies', 'role_templates', 'suppliers',
  'invoices', 'payments', 'payment_lines', 'bank_transactions', 'invoice_ocr',
  'z_reports', 'z_expenses', 'deposits', 'sales_entries', 'calendar_events',
  'change_requests', 'password_resets', 'audit_log',
];

/** Complete snapshot of every table as a plain JS object, ready to JSON.stringify. */
export async function exportAll(x = getExecutor()) {
  const tables = {};
  const counts = {};
  for (const t of ALL_TABLES) {
    const rows = await x.many(`SELECT * FROM ${t}`, []);
    tables[t] = rows;
    counts[t] = rows.length;
  }
  return {
    meta: { app: 'ap-control', backupVersion: 1, exportedAt: new Date().toISOString(), counts },
    tables,
  };
}

/**
 * Clear transactional data for a fresh start. Keeps companies/stores/bank accounts/users.
 * Deletes the Blob images referenced by invoices and z_expenses (best-effort).
 * @param {{alsoSuppliers?: boolean}} opts
 * @returns {{deletedImages:number}}
 */
export async function resetTransactionalData({ alsoSuppliers = false } = {}, actor, x = getExecutor()) {
  // Collect image refs BEFORE the rows go away, so their blobs can be deleted afterwards.
  const imgs = [
    ...(await x.many("SELECT image_path FROM invoices WHERE image_path IS NOT NULL", [])),
    ...(await x.many("SELECT image_path FROM z_expenses WHERE image_path IS NOT NULL", [])),
  ].map((r) => r.image_path).filter(Boolean);

  const order = alsoSuppliers ? [...RESET_ORDER, 'suppliers'] : RESET_ORDER;
  await tx(async (t) => {
    for (const table of order) {
      // 'audit_log' last so a mid-reset failure still leaves a coherent history; suppliers only
      // after invoices (FK). All tables exist per schema; a hard DELETE is fine.
      await t.run(`DELETE FROM ${table}`, []);
    }
  });

  // Best-effort blob cleanup (outside the tx — never blocks the reset).
  let deletedImages = 0;
  for (const ref of imgs) {
    await delStored(ref);
    deletedImages += 1;
  }

  // Record the reset itself (audit_log was just cleared — this is the first fresh entry).
  await logAction(
    { userId: actor?.id ?? null, action: 'data.reset', entityType: 'system', entityId: null, details: { alsoSuppliers, deletedImages } },
    x,
  );
  return { deletedImages };
}

/**
 * Restore a full backup produced by exportAll(). Replaces ALL data with the snapshot's rows,
 * atomically (wipe + insert in one transaction — a malformed file rolls back and leaves the
 * live data untouched). After commit, Postgres identity sequences are reseeded so new inserts
 * don't collide with restored ids (SQLite continues from max automatically).
 * @returns {{restored: Record<string,number>}}
 */
export async function restoreAll(dump, actor, x = getExecutor()) {
  if (!dump || dump.meta?.app !== 'ap-control' || !dump.tables || typeof dump.tables !== 'object') {
    throw new RuleError('RESTORE', 'קובץ גיבוי לא תקין — לא זוהה כגיבוי של AP Control.');
  }
  const restored = {};
  const idTables = [];
  await tx(async (t) => {
    // Wipe everything, children first.
    for (const table of [...RESTORE_ORDER].reverse()) await t.run(`DELETE FROM ${table}`, []);
    // Insert, parents first, preserving primary keys.
    for (const table of RESTORE_ORDER) {
      const rows = dump.tables[table];
      if (!Array.isArray(rows) || rows.length === 0) { restored[table] = 0; continue; }
      for (const row of rows) {
        const cols = Object.keys(row);
        const q = cols.map((c) => `"${c}"`).join(', ');
        const ph = cols.map(() => '?').join(', ');
        await t.run(`INSERT INTO ${table} (${q}) VALUES (${ph})`, cols.map((c) => row[c]));
      }
      restored[table] = rows.length;
      if (Object.prototype.hasOwnProperty.call(rows[0], 'id')) idTables.push(table);
    }
  });

  // Reseed Postgres identity sequences (no-op / unsupported on pg-mem — caught; SQLite N/A).
  if (getBackend() === 'pg') {
    for (const table of idTables) {
      try {
        await x.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}))`, []);
      } catch {
        /* real Neon supports this; the in-memory test backend does not */
      }
    }
  }

  // Best-effort audit entry (the acting user should exist in a same-system backup).
  try {
    await logAction(
      { userId: actor?.id ?? null, action: 'data.restore', entityType: 'system', entityId: null, details: { tables: Object.keys(restored).length } },
      x,
    );
  } catch {
    /* the restore already committed; a missing-user FK on the log must not fail it */
  }
  return { restored };
}
