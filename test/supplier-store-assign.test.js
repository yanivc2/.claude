// "למה אני רואה ספקים של חנויות אחרות" — the answer is that an unlinked supplier is SHARED with
// every store, never hidden (lib/scope.js#filterByStoreLinks; deliberate, so nothing vanished when
// supplier_stores was introduced). Until suppliers are actually assigned, choosing a branch cannot
// narrow the list, and the screen looks like a leak when it is showing unassigned rows.
//
// This suite pins both halves: the isolation really does hold (a supplier linked to another branch
// is NOT visible), and the tool that turns "unassigned" into a real link derives it from the
// invoices the supplier actually filed rather than from a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary } from './helpers.js';
import { createInvoice } from '../src/services/invoices.js';
import {
  createSupplier, approveSupplier, listSuppliers, setSupplierStores, supplierStoreSuggestions,
} from '../src/services/suppliers.js';

async function world() {
  const db = await freshDb();
  const own = await owner(db);
  const sec = await secretary(db);
  const [a, b] = await db.many('SELECT * FROM stores ORDER BY id', []);
  const mk = async (name) => approveSupplier((await createSupplier({ name }, sec, db)).id, own, db);
  let n = 0;
  const bill = async (sup, store, count) => {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      await createInvoice(
        { supplierId: sup.id, storeId: store.id, invoiceNumber: `A-${n}`, invoiceDate: `2026-0${(n % 9) + 1}-1${n % 9}`,
          amountBeforeVat: 10000 + n * 137, vatAmount: 1800 + n * 24, docType: 'tax_invoice' },
        sec, db, );
    }
  };
  return { db, own, sec, a, b, mk, bill };
}
const scopeOf = (store) => ({ companyIds: [store.company_id], storeIds: [store.id] });

test('a supplier with no store link is SHARED — that is why it shows under any active store', async () => {
  const { db, a, b, mk } = await world();
  const shared = await mk('אוסם נסטלה');
  const theirs = await mk('ספק של הסניף השני');
  await setSupplierStores(theirs.id, [b.id], db);

  const seen = (await listSuppliers(null, db, { scope: scopeOf(a) })).map((s) => s.name);
  assert.ok(seen.includes('אוסם נסטלה'), 'unlinked = shared with every store, never hidden');
  assert.ok(!seen.includes('ספק של הסניף השני'), 'a supplier linked to ANOTHER branch is not visible');
});

test('assigning it to one branch removes it from the other — the lock was never broken', async () => {
  const { db, a, b, mk } = await world();
  const sup = await mk('ירקן מידנייט');
  assert.ok((await listSuppliers(null, db, { scope: scopeOf(a) })).some((s) => s.name === 'ירקן מידנייט'));

  await setSupplierStores(sup.id, [b.id], db);
  assert.ok(!(await listSuppliers(null, db, { scope: scopeOf(a) })).some((s) => s.name === 'ירקן מידנייט'));
  assert.ok((await listSuppliers(null, db, { scope: scopeOf(b) })).some((s) => s.name === 'ירקן מידנייט'));
});

test('the assignment is suggested from the invoices the supplier actually filed', async () => {
  const { db, a, b, mk, bill } = await world();
  const onlyA = await mk('ספק סניף א');
  const both = await mk('ספק שני הסניפים');
  const never = await mk('ספק בלי חשבוניות');
  const already = await mk('ספק ששויך כבר');
  await bill(onlyA, a, 3);
  await bill(both, a, 1);
  await bill(both, b, 4);
  await bill(already, a, 2);
  await setSupplierStores(already.id, [a.id], db);

  const sug = await supplierStoreSuggestions(null, db);
  const by = (name) => sug.find((c) => c.name === name);

  assert.deepEqual(by('ספק סניף א').stores.map((s) => s.id), [a.id]);
  assert.equal(by('ספק סניף א').invoices, 3);

  // Two branches → both offered, busiest first. One supplier, two links, exactly as designed.
  assert.deepEqual(by('ספק שני הסניפים').stores.map((s) => s.id), [b.id, a.id]);
  assert.deepEqual(by('ספק שני הסניפים').stores.map((s) => s.n), [4, 1]);

  assert.equal(by('ספק בלי חשבוניות'), undefined, 'nothing to infer, so nothing is offered');
  assert.equal(by('ספק ששויך כבר'), undefined, 'an existing assignment is somebody’s decision — left alone');
});

test('the suggestion never names a store outside the caller’s grants', async () => {
  const { db, a, b, mk, bill } = await world();
  const sup = await mk('ספק חוצה סניפים');
  await bill(sup, a, 2);
  await bill(sup, b, 5);

  const sug = await supplierStoreSuggestions(scopeOf(a), db);
  const row = sug.find((c) => c.name === 'ספק חוצה סניפים');
  assert.deepEqual(row.stores.map((s) => s.id), [a.id], 'the other branch is not named back');
  assert.equal(row.invoices, 2, 'and its invoices there are not counted either');
});
