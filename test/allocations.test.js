// R8 — an invoice that arrives AFTER the money was paid. The worked case: 12 rent checks handed
// to the landlord up front, then one invoice covering 3 months. The mirror of "several invoices on
// one check", which already worked and must keep working untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment, voidPayment, getPaymentDetail } from '../src/services/payments.js';
import {
  allocateInvoiceToPayments,
  deallocate,
  invoiceAllocation,
  paymentAllocation,
  openAdvancesForSupplier,
} from '../src/services/allocations.js';

/** A landlord, an account, and N monthly rent checks paid on account. */
async function rentSetup(db, { checks = 3, each = 500000 } = {}) {
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('בעל הנכס', 'approved')", []);
  const landlord = await db.one("SELECT * FROM suppliers WHERE name='בעל הנכס'", []);

  const payments = [];
  for (let i = 0; i < checks; i += 1) {
    payments.push(
      await createPayment(
        {
          bankAccountId: ba.id,
          method: 'check',
          checkNumber: String(7000 + i),
          paymentDate: `2026-0${i + 1}-01`,
          supplierId: landlord.id,
          amount: each,
        },
        ow, db,
      ),
    );
  }
  return { ow, store, ba, landlord, payments };
}

test('an advance is a payment with a supplier, an amount and no invoice — the whole sum sits on account', async () => {
  const db = await freshDb();
  const { payments } = await rentSetup(db, { checks: 1 });
  const p = payments[0];
  assert.equal(p.amount, 500000);
  assert.equal(p.status, 'issued');

  const alloc = await paymentAllocation(p.id, db);
  assert.deepEqual(alloc, { amount: 500000, allocated: 0, unallocated: 500000 });
});

test('an advance without a supplier or without an amount is refused', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  const base = { bankAccountId: ba.id, method: 'check', checkNumber: '8001', paymentDate: '2026-01-01' };

  await assert.rejects(() => createPayment({ ...base, amount: 1000 }, ow, db), /חובה לבחור ספק/);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ס', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='ס'", []);
  await assert.rejects(() => createPayment({ ...base, supplierId: sup.id }, ow, db), /חובה סכום חיובי/);
  await assert.rejects(() => createPayment({ ...base, supplierId: sup.id, amount: -5 }, ow, db), /חובה סכום חיובי/);
});

test('a typed amount alongside invoices is refused — with invoices the amount is derived (R5)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ס', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='ס'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'A1', invoiceDate: '2026-01-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT id FROM invoices WHERE invoice_number='A1'", []);
  await assert.rejects(
    () => createPayment(
      { bankAccountId: ba.id, method: 'check', checkNumber: '8100', paymentDate: '2026-01-05', invoiceIds: [inv.id], amount: 999 },
      ow, db,
    ),
    /הסכום נגזר מהן/,
  );
});

test('THE CASE: an invoice for 3 months attaches to the 3 rent checks already paid', async () => {
  const db = await freshDb();
  const { ow, store, ba, landlord, payments } = await rentSetup(db, { checks: 3, each: 500000 });

  // The landlord finally issues one invoice for 3 months: 15,000 ₪.
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-Q1', invoiceDate: '2026-03-31', amountBeforeVat: 1500000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-Q1'", []);
  await approveInvoiceForPayment(inv.id, ow, db);

  // The three checks are offered as open advances, oldest first.
  const open = await openAdvancesForSupplier(landlord.id, ba.id, db);
  assert.equal(open.length, 3);
  assert.deepEqual(open.map((p) => p.check_number), ['7000', '7001', '7002']);
  assert.equal(open.every((p) => p.unallocated === 500000), true);

  const r = await allocateInvoiceToPayments(inv.id, payments.map((p) => ({ paymentId: p.id })), ow, db);
  assert.equal(r.applied, 1500000);
  assert.equal(r.open, 0);
  assert.equal(r.status, 'paid');

  assert.deepEqual(await invoiceAllocation(inv.id, db), { total: 1500000, allocated: 1500000, open: 0 });
  assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id])).status, 'paid');

  // Each check is now fully consumed, and each shows the invoice on it.
  for (const p of payments) {
    assert.deepEqual(await paymentAllocation(p.id, db), { amount: 500000, allocated: 500000, unallocated: 0 });
    const detail = await getPaymentDetail(p.id, db);
    assert.equal(detail.lines.length, 1);
  }
  // Nothing left on account for this landlord.
  assert.deepEqual(await openAdvancesForSupplier(landlord.id, ba.id, db), []);
});

test('a partly covered invoice stays payable, with only its remaining balance open', async () => {
  const db = await freshDb();
  const { ow, store, ba, landlord, payments } = await rentSetup(db, { checks: 3, each: 500000 });
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-H1', invoiceDate: '2026-06-30', amountBeforeVat: 3000000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-H1'", []);
  await approveInvoiceForPayment(inv.id, ow, db);

  // 30,000 ₪ invoice, only 15,000 ₪ of checks so far.
  const r = await allocateInvoiceToPayments(inv.id, payments.map((p) => ({ paymentId: p.id })), ow, db);
  assert.equal(r.applied, 1500000);
  assert.equal(r.status, 'approved_for_payment', 'not fully covered → still payable');
  assert.deepEqual(await invoiceAllocation(inv.id, db), { total: 3000000, allocated: 1500000, open: 1500000 });

  // A fourth check later closes it.
  const p4 = await createPayment(
    { bankAccountId: ba.id, method: 'check', checkNumber: '7100', paymentDate: '2026-07-01', supplierId: landlord.id, amount: 1500000 },
    ow, db,
  );
  const r2 = await allocateInvoiceToPayments(inv.id, [{ paymentId: p4.id }], ow, db);
  assert.equal(r2.status, 'paid');
  assert.equal((await invoiceAllocation(inv.id, db)).open, 0);
});

test('an allocation never takes more than the payment holds or the invoice still owes', async () => {
  const db = await freshDb();
  const { ow, store, landlord, payments } = await rentSetup(db, { checks: 2, each: 500000 });
  // A 6,000 ₪ invoice against two 5,000 ₪ checks: the first is capped by the check, the second by
  // what the invoice still owes — never over-allocating either side.
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-X', invoiceDate: '2026-02-28', amountBeforeVat: 600000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-X'", []);
  await approveInvoiceForPayment(inv.id, ow, db);

  const r = await allocateInvoiceToPayments(
    inv.id,
    [{ paymentId: payments[0].id, amount: 900000 }, { paymentId: payments[1].id }],
    ow, db,
  );
  assert.equal(r.applied, 600000);
  assert.equal(r.status, 'paid');
  assert.equal((await paymentAllocation(payments[0].id, db)).allocated, 500000, 'capped by the check');
  assert.equal((await paymentAllocation(payments[1].id, db)).allocated, 100000, 'capped by the invoice');
  assert.equal((await paymentAllocation(payments[1].id, db)).unallocated, 400000, 'the rest stays on account');
});

test('refusals: a fully allocated invoice, the same payment twice, and a voided payment', async () => {
  const db = await freshDb();
  const { ow, store, landlord, payments } = await rentSetup(db, { checks: 2, each: 500000 });
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-Y', invoiceDate: '2026-02-28', amountBeforeVat: 500000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-Y'", []);
  await approveInvoiceForPayment(inv.id, ow, db);

  await allocateInvoiceToPayments(inv.id, [{ paymentId: payments[0].id }], ow, db);
  await assert.rejects(() => allocateInvoiceToPayments(inv.id, [{ paymentId: payments[1].id }], ow, db), /כבר משויכת במלואה/);
  await assert.rejects(() => allocateInvoiceToPayments(inv.id, [{ paymentId: payments[0].id }], ow, db), /כבר משויכת במלואה/);
  await assert.rejects(() => allocateInvoiceToPayments(inv.id, [], ow, db), /לא נבחרו תשלומים/);

  await voidPayment(payments[1].id, ow, 'טעות', db);
  await assert.rejects(() => allocateInvoiceToPayments(inv.id, [{ paymentId: payments[1].id }], ow, db), /כבר משויכת במלואה/);
});

test('voiding one of several covering checks re-opens the invoice; the others keep their share', async () => {
  const db = await freshDb();
  const { ow, store, landlord, payments } = await rentSetup(db, { checks: 3, each: 500000 });
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-Z', invoiceDate: '2026-03-31', amountBeforeVat: 1500000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-Z'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  await allocateInvoiceToPayments(inv.id, payments.map((p) => ({ paymentId: p.id })), ow, db);
  assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id])).status, 'paid');

  // One check is voided (it was written wrong). The invoice is no longer fully covered.
  await voidPayment(payments[1].id, ow, 'צ׳ק שגוי', db);
  const after = await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id]);
  assert.equal(after.status, 'approved_for_payment', 'not paid any more — 5,000 ₪ are open again');
  assert.deepEqual(await invoiceAllocation(inv.id, db), { total: 1500000, allocated: 1000000, open: 500000 });
});

test('deallocate returns the money to account and re-opens the invoice', async () => {
  const db = await freshDb();
  const { ow, store, ba, landlord, payments } = await rentSetup(db, { checks: 1, each: 500000 });
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-D', invoiceDate: '2026-01-31', amountBeforeVat: 500000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-D'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  await allocateInvoiceToPayments(inv.id, [{ paymentId: payments[0].id }], ow, db);

  await deallocate(inv.id, payments[0].id, ow, db);
  assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id])).status, 'approved_for_payment');
  assert.deepEqual(await paymentAllocation(payments[0].id, db), { amount: 500000, allocated: 0, unallocated: 500000 });
  assert.equal((await openAdvancesForSupplier(landlord.id, ba.id, db)).length, 1, 'back on account');
});

test('an on_hold (R3) invoice cannot be allocated — the hold outranks it', async () => {
  const db = await freshDb();
  const { ow, store, landlord, payments } = await rentSetup(db, { checks: 1, each: 500000 });
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-H', invoiceDate: '2026-01-31', amountBeforeVat: 500000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-H'", []);
  await db.run("UPDATE invoices SET status = 'on_hold', hold_reason = 'R3: בדיקה' WHERE id = ?", [inv.id]);
  await assert.rejects(() => allocateInvoiceToPayments(inv.id, [{ paymentId: payments[0].id }], ow, db), /מוחזקת/);
});

test('a credit note is not allocated to an existing payment — it nets on a new one', async () => {
  const db = await freshDb();
  const { ow, store, landlord, payments } = await rentSetup(db, { checks: 1, each: 500000 });
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-C', invoiceDate: '2026-01-31', amountBeforeVat: -100000, vatAmount: 0, docType: 'credit_note' },
    ow, db,
  );
  const cn = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-C'", []);
  await assert.rejects(() => allocateInvoiceToPayments(cn.id, [{ paymentId: payments[0].id }], ow, db), /זיכוי/);
});

// --- the screens ------------------------------------------------------------------------------

test('the invoice page offers the open advances, and the form allocates them', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');

  const db = await freshDb();
  const { ow, store, landlord, payments } = await rentSetup(db, { checks: 3, each: 500000 });
  await createInvoice(
    { supplierId: landlord.id, storeId: store.id, invoiceNumber: 'RENT-UI', invoiceDate: '2026-03-31', amountBeforeVat: 1500000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='RENT-UI'", []);
  await approveInvoiceForPayment(inv.id, ow, db);

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `session=${createSession(ow.id)}`;
  try {
    const page = await (await fetch(`${base}/invoices/${inv.id}`, { headers: { cookie } })).text();
    assert.match(page, /שייך לתשלומים שכבר בוצעו/);
    for (const p of payments) assert.match(page, new RegExp(`name="payment_ids" value="${p.id}"`));

    const body = new URLSearchParams();
    for (const p of payments) body.append('payment_ids', String(p.id));
    const res = await fetch(`${base}/invoices/${inv.id}/allocate`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /alloc=/);
    assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id])).status, 'paid');

    // Now fully allocated: the panel is gone and all three payments are listed.
    const after = await (await fetch(`${base}/invoices/${inv.id}`, { headers: { cookie } })).text();
    assert.ok(!/שייך לתשלומים שכבר בוצעו/.test(after), 'nothing left to allocate');
    assert.match(after, /תשלומים<\/h2>/);
  } finally {
    server.close();
  }
});

test('the new-payment screen offers the on-account form, and it records an advance', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');

  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('בעל הנכס', 'approved')", []);
  const landlord = await db.one("SELECT * FROM suppliers WHERE name='בעל הנכס'", []);

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `session=${createSession(ow.id)}`;
  try {
    const page = await (await fetch(`${base}/payments/new`, { headers: { cookie } })).text();
    assert.match(page, /תשלום על החשבון/);
    assert.match(page, /name="advance_supplier_id"/);

    const body = new URLSearchParams({
      bank_account_id: String(ba.id),
      advance_supplier_id: String(landlord.id),
      advance_amount: '5000',
      method: 'check',
      check_number: '9001',
      payment_date: '2026-01-01',
    });
    const res = await fetch(`${base}/payments`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(res.status, 303);
    const pid = Number(res.headers.get('location').split('/').pop());
    assert.deepEqual(await paymentAllocation(pid, db), { amount: 500000, allocated: 0, unallocated: 500000 });
    assert.equal((await db.one('SELECT supplier_id FROM payments WHERE id = ?', [pid])).supplier_id, landlord.id);
  } finally {
    server.close();
  }
});
