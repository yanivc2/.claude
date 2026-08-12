import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { seed } from '../src/db/seed.js';
import { createSupplier } from '../src/services/suppliers.js';
import { createInvoice, setImage, getInvoice } from '../src/services/invoices.js';
import { toAgorot } from '../src/lib/money.js';

test('seed sets the company tax_ids', async () => {
  const db = await freshDb();
  const byName = async (n) => (await db.one('SELECT tax_id FROM companies WHERE name = ?', [n])).tax_id;
  assert.equal(await byName('יניב רום יזמות בע"מ'), '515325405');
  assert.equal(await byName('על הדרך סופר'), '514737832');
  assert.equal(await byName('פינק מרקט י.ר. בע"מ'), '516632627');
});

test('seed backfills a null tax_id but does not overwrite an existing one', async () => {
  const db = await freshDb();
  await db.run("UPDATE companies SET tax_id = NULL WHERE name = 'יניב רום יזמות בע\"מ'", []);
  await db.run("UPDATE companies SET tax_id = '999999999' WHERE name = 'על הדרך סופר'", []);
  await seed(db); // idempotent re-run
  assert.equal(
    (await db.one('SELECT tax_id FROM companies WHERE name = ?', ['יניב רום יזמות בע"מ'])).tax_id,
    '515325405', // backfilled
  );
  assert.equal(
    (await db.one('SELECT tax_id FROM companies WHERE name = ?', ['על הדרך סופר'])).tax_id,
    '999999999', // preserved, not clobbered
  );
});

test('createInvoice persists image_path; setImage replaces and returns the previous', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const sup = await createSupplier({ name: 'ספק' }, sec, db);
  const { invoice } = await createInvoice(
    {
      supplierId: sup.id,
      storeId: st.id,
      invoiceNumber: 'IMG-1',
      invoiceDate: '2026-07-01',
      amountBeforeVat: toAgorot('100'),
      vatAmount: toAgorot('17'),
      docType: 'tax_invoice',
      imagePath: 'first.jpg',
    },
    sec,
    db,
  );
  assert.equal(invoice.image_path, 'first.jpg');

  const previous = await setImage(invoice.id, 'second.png', await owner(db), db);
  assert.equal(previous, 'first.jpg');
  assert.equal((await getInvoice(invoice.id, db)).image_path, 'second.png');
});
