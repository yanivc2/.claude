import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { createZClosing, getZClosing, updateZClosing, deleteZClosing } from '../src/services/zclosing.js';

function closingInput(store, overrides = {}) {
  return {
    employeeFirst: 'רון', employeeLast: 'לוי', storeId: store.id, zNumber: '900',
    drawerCash: 40000, startedAt: '2026-08-13 09:00',
    counts: { 200: 2, 100: 0 }, // ₪400
    expenses: [{ desc: 'קפה', amount: 1500 }],
    ...overrides,
  };
}

test('getZClosing / updateZClosing recompute totals; delete removes it', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const id = await createZClosing(closingInput(store), o, x);

  let c = await getZClosing(id, x);
  assert.equal(c.total_cash, 40000); // 2×₪200
  assert.equal(c.total_expenses, 1500);
  assert.equal(c.grand_total, 41500);

  // Edit: change the bill count + expense; totals must be recomputed server-side.
  await updateZClosing(id, closingInput(store, { counts: { 200: 1, 100: 3 }, expenses: [{ desc: 'x', amount: 500 }] }), o, x);
  c = await getZClosing(id, x);
  assert.equal(c.total_cash, 50000); // ₪200 + 3×₪100 = ₪500
  assert.equal(c.total_expenses, 500);
  assert.equal(c.grand_total, 50500);

  await deleteZClosing(id, o, x);
  await assert.rejects(() => getZClosing(id, x), /לא נמצאה/);
});

test('updateZClosing validates (name + Z number required)', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const id = await createZClosing(closingInput(store), o, x);
  await assert.rejects(() => updateZClosing(id, closingInput(store, { zNumber: '' }), o, x), /מספר Z/);
  await assert.rejects(() => updateZClosing(id, closingInput(store, { employeeLast: '' }), o, x), /שם/);
});
