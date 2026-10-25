// בעלים 25/10: "הזינו חשבונית עם סכום גבוה ללא מספר הקצאה — זה החזיק את החשבונית. נכנסו לעריכה, הזינו מספר
// הקצאה, שמרו, וחזרו לדף החשבוניות — ניסו לסמן אותה יחד עם זיכוי, והיא עדיין מוחזקת. זה צריך מייד להתעדכן."
// מי שאינו הבעלים שמר עריכה → הכל (כולל מספר ההקצאה) נשלח לאישור, ולכן ההחזקה נשארה. השלמת מספר הקצאה חסר
// נשמרת עכשיו מיד (כמו הכפתור "הזן מספר הקצאה" בדף החשבונית), ורק שינויים אחרים הולכים לאישור.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, putOnHold, setAllocationNumber, listPayable } from '../src/services/invoices.js';
import { toAgorot } from '../src/lib/money.js';

async function world() {
  const db = await freshDb();
  const own = await owner(db);
  const sec = await secretary(db);
  await db.run(`UPDATE users SET permissions = '["nav_invoices","edit_invoice","view_all_stores"]' WHERE id = ?`, [sec.id]);
  const st = await firstStore(db);
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [sec.id, st.company_id]); // מזכירה של החברה
  const sup = await approveSupplier((await createSupplier({ name: 'ספק גדול' }, own, db)).id, own, db);
  const { invoice } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'BIG-1', invoiceDate: '2026-10-20',
    amountBeforeVat: toAgorot('20000'), vatAmount: toAgorot('3600'), docType: 'tax_invoice' }, own, db);
  const server = createApp().listen(0); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const edit = (user, fields) => {
    const body = new URLSearchParams({
      supplier_id: String(sup.id), store_id: String(st.id), ctx_store: String(st.id), invoice_number: 'BIG-1', invoice_date: '2026-10-20',
      amount_before_vat: '20000', vat_amount: '3600', doc_type: 'tax_invoice', allocation_number: '', ...fields,
    });
    return fetch(`${base}/invoices/${invoice.id}/edit`, { method: 'POST', redirect: 'manual', body,
      headers: { cookie: `session=${createSession(user.id)}; ap_store=${st.id}`, 'content-type': 'application/x-www-form-urlencoded' } });
  };
  return { db, own, sec, st, invoice, server, base, edit };
}

test('a secretary adding the missing allocation number in the edit form releases the R3 hold at once', async () => {
  const w = await world();
  try {
    assert.equal(w.invoice.status, 'on_hold');
    const r = await w.edit(w.sec, { allocation_number: '123456789' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `/invoices/${w.invoice.id}?edited=released`);
    const now = await w.db.one('SELECT status, allocation_number, hold_reason FROM invoices WHERE id = ?', [w.invoice.id]);
    assert.equal(now.allocation_number, '123456789');
    assert.equal(now.status, 'recorded');
    assert.equal(now.hold_reason, null);
    assert.ok((await listPayable(null, w.db)).some((i) => i.id === w.invoice.id), 'payable right away — can be ticked with a credit');
    assert.equal(Number((await w.db.one("SELECT COUNT(*) AS n FROM change_requests WHERE action = 'invoice.update'", [])).n), 0, 'nothing queued');
    const html = await (await fetch(`${w.base}${r.headers.get('location')}`, { headers: { cookie: `session=${createSession(w.sec.id)}; ap_store=${w.st.id}` } })).text();
    assert.match(html, /החשבונית שוחררה מההחזקה ואפשר לשלם אותה/);
  } finally { w.server.close(); }
});

test('allocation + another change: the allocation applies now, the rest goes to the owner', async () => {
  const w = await world();
  try {
    const r = await w.edit(w.sec, { allocation_number: '123456789', invoice_date: '2026-10-21' });
    assert.equal(r.headers.get('location'), `/invoices/${w.invoice.id}?edited=released-sent`);
    const now = await w.db.one('SELECT status, allocation_number, invoice_date FROM invoices WHERE id = ?', [w.invoice.id]);
    assert.equal(now.status, 'recorded');
    assert.equal(now.invoice_date, '2026-10-20', 'the date change waits for approval');
    assert.equal(Number((await w.db.one("SELECT COUNT(*) AS n FROM change_requests WHERE action = 'invoice.update'", [])).n), 1);
  } finally { w.server.close(); }
});

test('the owner editing in the allocation number releases the hold too', async () => {
  const w = await world();
  try {
    const r = await w.edit(w.own, { allocation_number: '123456789' });
    assert.equal(r.status, 303);
    const now = await w.db.one('SELECT status FROM invoices WHERE id = ?', [w.invoice.id]);
    assert.equal(now.status, 'recorded');
  } finally { w.server.close(); }
});

test('a manual owner hold is NOT released by an allocation number (only the automatic R3 hold is)', async () => {
  const w = await world();
  try {
    await setAllocationNumber(w.invoice.id, '111222333', w.own, w.db);           // R3 released
    await putOnHold(w.invoice.id, 'מחלוקת כמויות', w.own, w.db);               // manual hold
    await w.db.run('UPDATE invoices SET allocation_number = NULL WHERE id = ?', [w.invoice.id]);
    const fixed = await setAllocationNumber(w.invoice.id, '444555666', w.own, w.db);
    assert.equal(fixed.status, 'on_hold');
    assert.equal(fixed.allocation_number, '444555666');
  } finally { w.server.close(); }
});
