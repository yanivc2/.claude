// הפקדה שהתפצלה לכמה שקיות.
//
// הטבלה תמכה בזה מאז ומתמיד (אין UNIQUE על z_report_id) — מה שלא תמך זה הטופס, שהכיר שקית אחת,
// והרשימה, שסכמה רק את הראשונה. הפקדה מפוצלת שנספרה חלקית נראית כמו חוסר שלא קיים, וזה בדיוק
// המספר שאמור להתריע על מזומן חסר.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createZReport } from '../src/services/zreports.js';
import { replaceDepositsForZ, depositsForZ, depositTotalForZ } from '../src/services/deposits.js';

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const z = await createZReport(
    { storeId: store.id, zNumber: 'Z-900', zDate: '2026-09-08', dailyTotal: 700000, drawerCash: 120000 }, ow, db,
  );
  return { db, ow, store, z, ctx: { storeId: store.id, depositDate: '2026-09-08' } };
}
const BAGS = [{ bagNumber: 'BAG-1', amount: 90000 }, { bagNumber: 'BAG-2', amount: 58000 }];

test('two bags are two rows, and the declared total is their sum', async () => {
  const { db, ow, z, ctx } = await world();
  const r = await replaceDepositsForZ(z.id, BAGS, ctx, ow, db);
  assert.equal(r.created, 2);
  const rows = await depositsForZ(z.id, db);
  assert.deepEqual(rows.map((d) => d.bag_number), ['BAG-1', 'BAG-2']);
  assert.equal(await depositTotalForZ(z.id, db), 148000, 'the whole deposit, not the first bag');
});

test('re-saving updates rows in place — a bag keeps its id, and nothing is duplicated', async () => {
  const { db, ow, z, ctx } = await world();
  await replaceDepositsForZ(z.id, BAGS, ctx, ow, db);
  const before = await depositsForZ(z.id, db);

  const r = await replaceDepositsForZ(
    z.id, [{ id: before[0].id, bagNumber: 'BAG-1', amount: 95000 }, { id: before[1].id, bagNumber: 'BAG-2', amount: 58000 }],
    ctx, ow, db,
  );
  assert.equal(r.kept, 2);
  assert.equal(r.created, 0);
  const after = await depositsForZ(z.id, db);
  assert.deepEqual(after.map((d) => Number(d.id)), before.map((d) => Number(d.id)), 'same rows, not new ones');
  assert.equal(await depositTotalForZ(z.id, db), 153000);
});

test('a bag removed from the form is deleted; a third one is added', async () => {
  const { db, ow, z, ctx } = await world();
  await replaceDepositsForZ(z.id, BAGS, ctx, ow, db);
  const rows = await depositsForZ(z.id, db);

  const r = await replaceDepositsForZ(
    z.id, [{ id: rows[0].id, bagNumber: 'BAG-1', amount: 90000 }, { bagNumber: 'BAG-3', amount: 10000 }], ctx, ow, db,
  );
  assert.equal(r.removed, 1, 'BAG-2 was dropped from the form');
  assert.equal(r.created, 1);
  assert.deepEqual((await depositsForZ(z.id, db)).map((d) => d.bag_number), ['BAG-1', 'BAG-3']);
});

test('🔴 a bag already matched to a bank line is NEVER deleted by an edit', async () => {
  const { db, ow, store, z, ctx } = await world();
  await replaceDepositsForZ(z.id, BAGS, ctx, ow, db);
  const rows = await depositsForZ(z.id, db);
  const acct = await accountForStore(db, store.id);
  const txn = await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, '2026-09-09', 90000, 'הפקדה', 'BAG-1', 'csv')`, [acct.id],
  );
  await db.run('UPDATE deposits SET matched_txn_id = ?, recon_diff = 0 WHERE id = ?', [txn.lastInsertRowid, rows[0].id]);

  // Someone edits the Z and drops every bag from the form.
  const r = await replaceDepositsForZ(z.id, [], ctx, ow, db);
  assert.equal(r.locked, 1, 'the reconciled bag is kept — the bank already reported it');
  assert.equal(r.removed, 1, 'the unreconciled one goes');
  const left = await depositsForZ(z.id, db);
  assert.equal(left.length, 1);
  assert.equal(left[0].bag_number, 'BAG-1');
  assert.equal(Number(left[0].matched_txn_id), Number(txn.lastInsertRowid), 'and its match survived intact');
});

test('an empty form declares nothing, and stays empty', async () => {
  const { db, ow, z, ctx } = await world();
  const r = await replaceDepositsForZ(z.id, [{ id: null, bagNumber: '', amount: 0 }], ctx, ow, db);
  assert.equal(r.created, 0);
  assert.equal((await depositsForZ(z.id, db)).length, 0);
  assert.equal(await depositTotalForZ(z.id, db), 0);
});

test('emptying an existing row removes it — that is how a bag is taken back', async () => {
  const { db, ow, z, ctx } = await world();
  await replaceDepositsForZ(z.id, BAGS, ctx, ow, db);
  const rows = await depositsForZ(z.id, db);
  await replaceDepositsForZ(
    z.id, [{ id: rows[0].id, bagNumber: '', amount: 0 }, { id: rows[1].id, bagNumber: 'BAG-2', amount: 58000 }], ctx, ow, db,
  );
  assert.deepEqual((await depositsForZ(z.id, db)).map((d) => d.bag_number), ['BAG-2']);
});

test('"הופקד לבנק" is per bag — one may be deposited while the other is not', async () => {
  const { db, ow, z, ctx } = await world();
  await replaceDepositsForZ(
    z.id, [{ bagNumber: 'BAG-1', amount: 90000, deposited: true }, { bagNumber: 'BAG-2', amount: 58000, deposited: false }],
    ctx, ow, db,
  );
  const rows = await depositsForZ(z.id, db);
  assert.equal(Number(rows[0].deposited), 1);
  assert.equal(Number(rows[1].deposited), 0);
});
