import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { seed } from '../src/db/seed.js';
import { createSupplier } from '../src/services/suppliers.js';
import { createInvoice, setImage, getInvoice } from '../src/services/invoices.js';
import { toAgorot } from '../src/lib/money.js';

test('seed sets the three company tax_ids', () => {
  const db = freshDb();
  const byName = (n) => db.prepare('SELECT tax_id FROM companies WHERE name = ?').get(n).tax_id;
  assert.equal(byName('יניב רום יזמות בע"מ'), '515325405');
  assert.equal(byName('על הדרך 24 שעות בע"מ'), '514737832');
  assert.equal(byName('פינק מרקט י.ר. בע"מ'), '516632627');
});

test('seed backfills a null tax_id but does not overwrite an existing one', () => {
  const db = freshDb();
  // Simulate an older DB row: null one company, and set another to a manual value.
  db.prepare("UPDATE companies SET tax_id = NULL WHERE name = 'יניב רום יזמות בע\"מ'").run();
  db.prepare("UPDATE companies SET tax_id = '999999999' WHERE name = 'על הדרך 24 שעות בע\"מ'").run();
  seed(db); // idempotent re-run
  assert.equal(
    db.prepare('SELECT tax_id FROM companies WHERE name = ?').get('יניב רום יזמות בע"מ').tax_id,
    '515325405', // backfilled
  );
  assert.equal(
    db.prepare('SELECT tax_id FROM companies WHERE name = ?').get('על הדרך 24 שעות בע"מ').tax_id,
    '999999999', // preserved, not clobbered
  );
});

test('createInvoice persists image_path; setImage replaces and returns the previous', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sup = createSupplier({ name: 'ספק' }, secretary(db), db);
  const { invoice } = createInvoice(
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
    secretary(db),
    db,
  );
  assert.equal(invoice.image_path, 'first.jpg');

  const previous = setImage(invoice.id, 'second.png', owner(db), db);
  assert.equal(previous, 'first.jpg');
  assert.equal(getInvoice(invoice.id, db).image_path, 'second.png');
});
