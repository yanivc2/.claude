// "חשבוניות מעוקבות לתשלום" — חשבוניות שמחכות לטיפול של הספק לפני שסוגרים אותן.
//
// ההחלטה שהכל תלוי בה: זה **דגל ידני** (`invoices.tracked_for_payment`) ולא ערך ב-`status`.
// `on_hold` מנוהל אוטומטית — `updateInvoice` מדליק ומכבה אותו לפי R3 בכל עריכה, ותשלום מנקה
// אותו — כך שעיקוב שהיה יושב שם היה נמחק בשקט ברגע שמישהו מתקן שדה. הטסטים כאן נועלים בדיוק את זה.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { createInvoice, updateInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import {
  trackInvoice, releaseInvoice, setTrackedNote, listTracked, isTracked,
  trackedStatusLabel, trackedMessage, whatsappLink, mailtoLink, waPhone,
} from '../src/services/trackedInvoices.js';

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const sup = await approveSupplier(
    (await createSupplier({ name: 'טרה', phone: '050-1234567', email: 'ap@tara.co.il' }, ow, db)).id, ow, db,
  );
  let n = 0;
  const invoice = async (over = {}) => {
    n += 1;
    await createInvoice({
      supplierId: sup.id, storeId: store.id, invoiceNumber: `T-${n}`, invoiceDate: '2026-09-01',
      amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice',
      allocationNumber: `12345600${n}`, ...over,
    }, ow, db);
    return db.one('SELECT * FROM invoices WHERE invoice_number = ?', [over.invoiceNumber || `T-${n}`]);
  };
  return { db, ow, store, sup, invoice };
}

test('tracking puts the invoice on the page, with who and when', async () => {
  const { db, ow, invoice } = await world();
  const inv = await invoice();
  const after = await trackInvoice(inv.id, { note: 'מחכים לזיכוי' }, ow, db);
  assert.equal(isTracked(after), true);
  assert.equal(after.tracked_note, 'מחכים לזיכוי');
  assert.ok(after.tracked_at);
  assert.equal(Number(after.tracked_by), ow.id);

  const rows = await listTracked({ scope: null }, db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].supplier_name, 'טרה');
  assert.equal(rows[0].supplier_phone, '050-1234567', 'the supplier contact travels with the row, for the send buttons');
});

test('releasing takes it off the page — and keeps the explanation', async () => {
  const { db, ow, invoice } = await world();
  const inv = await invoice();
  await trackInvoice(inv.id, { note: 'זיכוי על 3 ארגזים' }, ow, db);
  const released = await releaseInvoice(inv.id, ow, db);
  assert.equal(isTracked(released), false);
  assert.equal(released.tracked_note, 'זיכוי על 3 ארגזים', 'what was owed stays readable after it is settled');
  assert.equal((await listTracked({ scope: null }, db)).length, 0);
  await assert.rejects(() => releaseInvoice(inv.id, ow, db), /אינה מעוקבת/);
});

test('🔴 editing the invoice does NOT clear the tracking', async () => {
  const { db, ow, sup, store, invoice } = await world();
  const inv = await invoice();
  await trackInvoice(inv.id, { note: 'מחכים לזיכוי' }, ow, db);
  // This is exactly what would have broken had tracking been an invoices.status value: updateInvoice
  // recomputes the R3 hold on every edit and would have overwritten it.
  await updateInvoice(inv.id, {
    supplierId: sup.id, storeId: store.id, invoiceNumber: inv.invoice_number, invoiceDate: '2026-09-02',
    amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice', allocationNumber: '123456001',
  }, ow, db);
  const after = await db.one('SELECT * FROM invoices WHERE id = ?', [inv.id]);
  assert.equal(isTracked(after), true);
  assert.equal(after.tracked_note, 'מחכים לזיכוי');
});

test('an invoice can be approved for payment and still be waiting on the supplier', async () => {
  const { db, ow, invoice } = await world();
  const inv = await invoice();
  await trackInvoice(inv.id, { note: 'זיכוי מובטח' }, ow, db);
  await approveInvoiceForPayment(inv.id, ow, db);
  const rows = await listTracked({ scope: null }, db);
  assert.equal(rows.length, 1, 'approval is not a resolution of what the supplier owes us');
  assert.equal(trackedStatusLabel(rows[0]).label, 'מעוקבת לתשלום', 'tracking is what the status column shows');
});

test('tracking twice only updates the note, and keeps the original date', async () => {
  const { db, ow, invoice } = await world();
  const inv = await invoice();
  const first = await trackInvoice(inv.id, { note: 'א' }, ow, db);
  const second = await trackInvoice(inv.id, { note: 'ב' }, ow, db);
  assert.equal(second.tracked_note, 'ב');
  assert.equal(second.tracked_at, first.tracked_at, 'it has been tracked since the first time, not the last');
  assert.equal((await listTracked({ scope: null }, db)).length, 1, 'and it is one row, not two');
});

test('the note can be edited on the page', async () => {
  const { db, ow, invoice } = await world();
  const inv = await invoice();
  await trackInvoice(inv.id, {}, ow, db);
  const after = await setTrackedNote(inv.id, '  חסר מסמך משלוח  ', ow, db);
  assert.equal(after.tracked_note, 'חסר מסמך משלוח', 'trimmed');
  assert.equal((await setTrackedNote(inv.id, '', ow, db)).tracked_note, null, 'emptied, not left as ""');
});

test('the search narrows by supplier, number, exact amount and date range', async () => {
  const { db, ow, store, invoice } = await world();
  const other = await approveSupplier((await createSupplier({ name: 'שופרסל' }, ow, db)).id, ow, db);
  const a = await invoice({ invoiceNumber: 'AA-1', invoiceDate: '2026-09-01' });
  const b = await invoice({ invoiceNumber: 'BB-2', invoiceDate: '2026-10-05', amountBeforeVat: 50000, vatAmount: 9000 });
  await createInvoice({
    supplierId: other.id, storeId: store.id, invoiceNumber: 'CC-3', invoiceDate: '2026-09-15',
    amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice', allocationNumber: '987654321',
  }, ow, db);
  const c = await db.one("SELECT * FROM invoices WHERE invoice_number = 'CC-3'", []);
  for (const inv of [a, b, c]) await trackInvoice(inv.id, {}, ow, db);

  const ids = async (filters) => (await listTracked({ scope: null, filters }, db)).map((r) => r.invoice_number).sort();
  assert.deepEqual(await ids({}), ['AA-1', 'BB-2', 'CC-3']);
  assert.deepEqual(await ids({ supplier: 'שופרסל' }), ['CC-3']);
  assert.deepEqual(await ids({ number: 'bb' }), ['BB-2'], 'case-insensitive substring');
  assert.deepEqual(await ids({ amount: '590' }), ['BB-2'], '₪590.00 = 59000 agorot');
  assert.deepEqual(await ids({ from: '2026-09-10' }), ['BB-2', 'CC-3']);
  assert.deepEqual(await ids({ from: '2026-09-01', to: '2026-09-30' }), ['AA-1', 'CC-3']);
  assert.deepEqual(await ids({ supplier: 'טרה', to: '2026-09-30' }), ['AA-1'], 'filters combine');
});

test('🔒 another company never sees a tracked invoice', async () => {
  const { db, ow, store, invoice } = await world();
  const inv = await invoice();
  await trackInvoice(inv.id, {}, ow, db);
  const other = await db.one(
    'SELECT id, company_id FROM stores WHERE company_id <> (SELECT company_id FROM stores WHERE id = ?) LIMIT 1', [store.id],
  );
  assert.equal((await listTracked({ scope: null }, db)).length, 1);
  if (other) {
    const scoped = await listTracked(
      { scope: { companyIds: [Number(other.company_id)], storeIds: [Number(other.id)] } }, db,
    );
    assert.equal(scoped.length, 0);
  }
});

test('the message to the supplier is DERIVED from the invoice, never retyped', async () => {
  const inv = {
    invoice_number: '1234', invoice_date: '2026-09-01', total_amount: 118000,
    supplier_name: 'טרה', tracked_note: 'מחכים לזיכוי על 3 ארגזים שלא סופקו.',
    supplier_phone: '050-1234567', supplier_email: 'ap@tara.co.il',
  };
  const msg = trackedMessage(inv);
  for (const part of ['שלום טרה', '1234', '2026-09-01', '1,180.00 ₪', 'מחכים לזיכוי על 3 ארגזים שלא סופקו.']) {
    assert.ok(msg.includes(part), `the message must carry ${part}`);
  }
  // No note yet → still a complete message, not an empty one.
  assert.match(trackedMessage({ ...inv, tracked_note: null }), /מעוכבת לתשלום עד להשלמת טיפול/);

  assert.ok(whatsappLink(inv).startsWith('https://wa.me/972501234567?text='), 'Israeli number → international');
  assert.ok(mailtoLink(inv).startsWith('mailto:ap%40tara.co.il?subject='));
  // No phone → wa.me with no number, so WhatsApp asks which contact instead of failing.
  assert.ok(whatsappLink({ ...inv, supplier_phone: null, supplier_contact_phone: null }).startsWith('https://wa.me/?text='));
  assert.equal(waPhone('0501234567'), '972501234567');
  assert.equal(waPhone('+972-50-123-4567'), '972501234567');
  assert.equal(waPhone(''), '');
});
