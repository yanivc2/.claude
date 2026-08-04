import { getExecutor, tx } from '../db/adapter.js';
import { del as delStored } from '../lib/storage.js';
import { logAction } from './audit.js';

// Full logical backup + a "start fresh" reset for go-live. Both are owner-only (enforced at the
// route). The backup is a complete JSON snapshot of every table; the reset clears transactional
// data (and its Blob images) while keeping the setup (companies/stores/bank accounts/users).

// Every table, setup first. Used for the export.
const ALL_TABLES = [
  'companies', 'stores', 'bank_accounts', 'users', 'user_companies',
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
export const RESET_KEEPS = ['companies', 'stores', 'bank_accounts', 'users', 'user_companies'];

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
