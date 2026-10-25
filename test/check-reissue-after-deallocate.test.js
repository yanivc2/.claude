// בעלים 25/10: "במידה ועשיתי ביטול התאמה לצ׳ק ['בטל שיוך' בדף החשבונית], ואני רוצה להנפיק תשלום לחשבונית אחרת
// עם אותו מספר הצ׳ק — אפשר זאת כל עוד אני משלם אך ורק לאותו הספק ולא יאוחר משעה אחרי הפירוק." והתשלום החדש
// מחליף את הישן (הישן מתבטל ומקושר אליו) — תמיד צ׳ק חי אחד בכל מספר.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createPayment, reissuableCheck } from '../src/services/payments.js';
import { deallocate } from '../src/services/allocations.js';
import { listVoidedChecks } from '../src/services/voidedChecks.js';
import { voidedCheckHits } from '../src/services/reconciliation.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { toAgorot } from '../src/lib/money.js';

async function world() {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const ba = await accountForStore(db, st.id);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק א' }, o, db)).id, o, db);
  const other = await approveSupplier((await createSupplier({ name: 'ספק ב' }, o, db)).id, o, db);
  let n = 0;
  const inv = async (supplierId, amount = '1000') => (await createInvoice({ supplierId, storeId: st.id, invoiceNumber: `RI-${++n}`,
    invoiceDate: `2026-10-${String(10 + n).padStart(2, '0')}`, amountBeforeVat: toAgorot(amount), vatAmount: 0, docType: 'tax_invoice' }, o, db)).invoice;
  const pay = (invoiceIds, checkNumber = '50001') => createPayment({ bankAccountId: ba.id, method: 'check', checkNumber, paymentDate: '2026-10-25', invoiceIds }, o, db);
  return { db, o, st, ba, sup, other, inv, pay };
}

test('after "בטל שיוך" the same check number can pay another invoice of the SAME supplier — and replaces the old check', async () => {
  const { db, o, sup, inv, pay } = await world();
  const a = await inv(sup.id);
  const b = await inv(sup.id, '1200');
  const first = await pay([a.id]);
  await deallocate(a.id, first.id, o, db);
  assert.deepEqual(await reissuableCheck(first.id, { invoiceIds: [b.id] }, db), { ok: true });
  const second = await pay([b.id]);
  assert.notEqual(second.id, first.id);
  assert.equal(second.check_number, '50001');
  assert.equal(second.amount, toAgorot('1200'), 'the amount follows the new invoice');
  const old = await db.one('SELECT status, void_reason, void_link_payment_id FROM payments WHERE id = ?', [first.id]);
  assert.equal(old.status, 'voided');
  assert.equal(old.void_reason, 'method_changed');
  assert.equal(Number(old.void_link_payment_id), second.id, 'the old check points at its replacement');
  const live = await db.many("SELECT id FROM payments WHERE check_number = '50001' AND status <> 'voided'", []);
  assert.equal(live.length, 1, 'one live check per number');
  assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [a.id])).status !== 'paid', true, 'A is payable again');
  assert.ok(await db.one("SELECT id FROM audit_log WHERE action = 'payment.reissued' AND entity_id = ?", [first.id]));
  // not a voided check to chase: the number lives on in its replacement.
  assert.ok(!(await listVoidedChecks({}, db)).some((r) => Number(r.id) === first.id), 'not on the voided-checks page');
  await db.run(`INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
                VALUES (?, '2026-10-26', ?, 'צ׳ק', '50001', 'manual')`, [second.bank_account_id, -toAgorot('1000')]);
  assert.deepEqual(await voidedCheckHits(second.bank_account_id, db), [], 'a debit with that number is not a "voided check cashed" alarm');
});

test('another supplier — refused', async () => {
  const { o, db, sup, other, inv, pay } = await world();
  const a = await inv(sup.id);
  const c = await inv(other.id);
  const first = await pay([a.id]);
  await deallocate(a.id, first.id, o, db);
  await assert.rejects(() => pay([c.id]), /רק לאותו ספק/);
});

test('more than an hour after the dismantling — refused', async () => {
  const { o, db, sup, inv, pay } = await world();
  const a = await inv(sup.id);
  const b = await inv(sup.id, '1200');
  const first = await pay([a.id]);
  await deallocate(a.id, first.id, o, db);
  const old = new Date(Date.now() - 61 * 60000).toISOString().slice(0, 19).replace('T', ' ');
  await db.run("UPDATE audit_log SET timestamp = ? WHERE action = 'invoice.deallocate'", [old]);
  await assert.rejects(() => pay([b.id]), /עברה יותר משעה/);
});

test('a check still carrying an invoice (not dismantled), or never dismantled — the usual refusal', async () => {
  const { o, db, sup, inv, pay } = await world();
  const a = await inv(sup.id);
  const a2 = await inv(sup.id, '500');
  const b = await inv(sup.id, '1200');
  const first = await pay([a.id, a2.id]);
  await assert.rejects(() => pay([b.id]), /כבר קיים בחשבון זה/);
  await deallocate(a.id, first.id, o, db);                      // only one of its two invoices
  await assert.rejects(() => pay([b.id]), /כבר קיים בחשבון זה/);
});

test('the invoice page says the number is free for the next hour after "בטל שיוך" empties a check', async () => {
  const { db, o, st, sup, inv, pay } = await world();
  const a = await inv(sup.id);
  const first = await pay([a.id]);
  const server = createApp().listen(0); await once(server, 'listening');
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/invoices/${a.id}/deallocate`, {
      method: 'POST', redirect: 'manual', body: new URLSearchParams({ payment_id: String(first.id) }),
      headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(r.status, 303);
    assert.match(decodeURIComponent(r.headers.get('location')), /צ׳ק 50001 נשאר בלי חשבונית — בשעה הקרובה אפשר להנפיק את אותו מספר צ׳ק לחשבונית אחרת של אותו ספק/);
  } finally { server.close(); }
});
