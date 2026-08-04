import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

// "הצהרה על הפקדה" — a bank deposit declaration: a bag number + amount for a store, with a flag
// recording whether it was actually deposited to the bank.

export async function createDeposit(
  { storeId, depositDate, bagNumber = null, amount = 0, deposited = false },
  actor,
  x = getExecutor(),
) {
  if (!storeId) throw new RuleError('VALIDATION', 'חנות חובה');
  if (!depositDate) throw new RuleError('VALIDATION', 'תאריך הפקדה חובה');
  const info = await x.run(
    'INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [Number(storeId), depositDate, (bagNumber && String(bagNumber).trim()) || null, amount, deposited ? 1 : 0, actor.id],
  );
  await logAction(
    { userId: actor.id, action: 'deposit.create', entityType: 'deposit', entityId: info.lastInsertRowid, details: { amount, deposited: !!deposited } },
    x,
  );
  return info.lastInsertRowid;
}

export async function listDeposits({ storeId = null, limit = 30 } = {}, x = getExecutor()) {
  const base = `SELECT d.*, st.name AS store_name, c.name AS company_name
                  FROM deposits d
                  JOIN stores st ON st.id = d.store_id
                  JOIN companies c ON c.id = st.company_id`;
  if (storeId) {
    return x.many(`${base} WHERE d.store_id = ? ORDER BY d.deposit_date DESC, d.id DESC LIMIT ?`, [storeId, limit]);
  }
  return x.many(`${base} ORDER BY d.deposit_date DESC, d.id DESC LIMIT ?`, [limit]);
}

export async function setDeposited(id, deposited, actor, x = getExecutor()) {
  const row = await x.one('SELECT id FROM deposits WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`הפקדה ${id} לא נמצאה`);
  await x.run('UPDATE deposits SET deposited = ? WHERE id = ?', [deposited ? 1 : 0, id]);
  await logAction({ userId: actor.id, action: 'deposit.mark', entityType: 'deposit', entityId: id, details: { deposited: !!deposited } }, x);
}

export async function deleteDeposit(id, actor, x = getExecutor()) {
  await x.run('DELETE FROM deposits WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'deposit.delete', entityType: 'deposit', entityId: id }, x);
}
