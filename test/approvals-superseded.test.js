// בעלים 25/10 (צילום "ממתינות לאישור (3)"): שתי בקשות "חשבונית #1017 · מספר הקצאה: — ← 218010738" — "שיניתי אותם
// אחרי שהם הוחזקו. איך מבטלים את ההתראה?"; ושלישית "חשבונית #1001: ללא שינוי" — "לא מצליח להבין מה זה החשבונית
// ולא יכול ללחוץ להיכנס לפרטים". בקשה שהשינוי שלה כבר קיים נסגרת לבד; לכל בקשה — קישור לחשבונית.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, getInvoiceDetail, setAllocationNumber } from '../src/services/invoices.js';
import { submitRequest, closeSupersededRequests, countPending } from '../src/services/changeRequests.js';
import { describeInvoice } from '../src/lib/changeSummary.js';
import { toAgorot } from '../src/lib/money.js';

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const sec = await secretary(db);
  const st = await firstStore(db);
  const sup = await approveSupplier((await createSupplier({ name: 'סנו החברה הדרומית' }, ow, db)).id, ow, db);
  const { invoice } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: '55012', invoiceDate: '2026-10-20',
    amountBeforeVat: toAgorot('20000'), vatAmount: toAgorot('3600'), docType: 'tax_invoice' }, ow, db);
  const fieldsOf = (cur, over = {}) => ({ supplierId: cur.supplier_id, storeId: cur.store_id, invoiceNumber: cur.invoice_number,
    allocationNumber: cur.allocation_number, invoiceDate: cur.invoice_date, amountBeforeVat: Math.abs(cur.amount_before_vat),
    vatAmount: Math.abs(cur.vat_amount), docType: cur.doc_type, ...over });
  const ask = async (over) => {
    const cur = await getInvoiceDetail(invoice.id, db);
    const fields = fieldsOf(cur, over);
    return submitRequest({ action: 'invoice.update', entityType: 'invoice', entityId: invoice.id, payload: { id: invoice.id, fields }, summary: describeInvoice(cur, fields) }, sec, db);
  };
  return { db, ow, sec, st, invoice, ask };
}

test('the summary names the invoice by its number and supplier, not the internal id', async () => {
  const { db, invoice } = await world();
  const cur = await getInvoiceDetail(invoice.id, db);
  assert.match(describeInvoice(cur, { ...cur, supplierId: cur.supplier_id, storeId: cur.store_id, invoiceNumber: '55012', invoiceDate: cur.invoice_date,
    allocationNumber: '218010738', amountBeforeVat: Math.abs(cur.amount_before_vat), vatAmount: Math.abs(cur.vat_amount), docType: cur.doc_type }),
  /^חשבונית 55012 · סנו החברה הדרומית:\nמספר הקצאה: — ← 218010738$/);
});

test('requests already done by the owner — and no-change requests — close themselves; a different change stays', async () => {
  const { db, ow, invoice, ask } = await world();
  const a = await ask({ allocationNumber: '218010738' });
  const b = await ask({ allocationNumber: '218010738' });
  const none = await ask({});                                     // "ללא שינוי"
  const other = await ask({ invoiceDate: '2026-10-21' });          // a real, different change
  assert.equal(await countPending(db), 4);
  await setAllocationNumber(invoice.id, '218010738', ow, db);      // the owner did it himself
  assert.equal(await closeSupersededRequests(db), 3);
  const st = async (id) => (await db.one('SELECT status, decision_note FROM change_requests WHERE id = ?', [id]));
  for (const id of [a, b, none]) {
    assert.equal((await st(id)).status, 'superseded');
    assert.match((await st(id)).decision_note, /השינוי כבר קיים בחשבונית/);
  }
  assert.equal((await st(other)).status, 'pending', 'a request that would change something is the owner\'s call');
  assert.equal(await closeSupersededRequests(db), 0, 'idempotent');
});

test('/approvals closes them on open, shows "נסגר — כבר בוצע" in history, and links each request to its invoice', async () => {
  const { db, ow, invoice, ask } = await world();
  await ask({ allocationNumber: '218010738' });
  await ask({ invoiceDate: '2026-10-22' });
  await db.run("UPDATE invoices SET allocation_number = '218010738' WHERE id = ?", [invoice.id]);
  const server = createApp().listen(0); await once(server, 'listening');
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/approvals`, { headers: { cookie: `session=${createSession(ow.id)}` } })).text();
    assert.match(html, /ממתינות לאישור \(1\)/);
    assert.match(html, new RegExp(`<a href="/invoices/${invoice.id}">פתח את החשבונית ←</a>`));
    assert.match(html, /נסגר — כבר בוצע/);
  } finally { server.close(); }
});
