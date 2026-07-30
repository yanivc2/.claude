import { getDb } from '../db/index.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

// Manual register (Z) sales entries — the only manual input to the profitability report (§7).

/**
 * Record a register (Z) total for a store on a business day.
 * @param {{storeId:number, saleDate:string, amount:number, notes?:string}} input  amount in agorot
 */
export function addSalesEntry({ storeId, saleDate, amount, notes = null }, actor, db = getDb()) {
  const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);
  if (!saleDate) throw new RuleError('VALIDATION', 'תאריך חובה');
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RuleError('VALIDATION', 'סכום מכירות חייב להיות מספר לא-שלילי');
  }

  const info = db
    .prepare('INSERT INTO sales_entries (store_id, sale_date, amount, notes, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(storeId, saleDate, amount, notes?.trim() || null, actor.id);

  logAction(
    { userId: actor.id, action: 'sales.add', entityType: 'sales_entry', entityId: info.lastInsertRowid, details: { storeId, saleDate, amount } },
    db,
  );
  return db.prepare('SELECT * FROM sales_entries WHERE id = ?').get(info.lastInsertRowid);
}

export function deleteSalesEntry(id, actor, db = getDb()) {
  const row = db.prepare('SELECT * FROM sales_entries WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`רשומת מכירות ${id} לא נמצאה`);
  db.prepare('DELETE FROM sales_entries WHERE id = ?').run(id);
  logAction({ userId: actor.id, action: 'sales.delete', entityType: 'sales_entry', entityId: id }, db);
}

/** Recent Z entries with store names, newest first. */
export function listSalesEntries(limit = 50, db = getDb()) {
  return db
    .prepare(
      `SELECT se.*, st.name AS store_name
         FROM sales_entries se JOIN stores st ON st.id = se.store_id
        ORDER BY se.sale_date DESC, se.id DESC
        LIMIT ?`,
    )
    .all(limit);
}
