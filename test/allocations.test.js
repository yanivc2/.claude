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

// --- one supplier per payment (except a supplier family) ---------------------------------------

async function twoSuppliers(db) {
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('קוקה קולה', 'approved')", []);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('אסם', 'approved')", []);
  const cola = await db.one("SELECT * FROM suppliers WHERE name='קוקה קולה'", []);
  const tara = await db.one("SELECT * FROM suppliers WHERE name='טרה'", []);
  const osem = await db.one("SELECT * FROM suppliers WHERE name='אסם'", []);
  await db.run('UPDATE suppliers SET parent_supplier_id = ? WHERE id = ?', [cola.id, tara.id]);

  const mk = async (sup, num, amount) => {
    await createInvoice(
      { supplierId: sup.id, storeId: store.id, invoiceNumber: num, invoiceDate: '2026-01-10', amountBeforeVat: amount, vatAmount: 0, docType: 'tax_invoice' },
      ow, db,
    );
    const inv = await db.one('SELECT * FROM invoices WHERE invoice_number = ?', [num]);
    await approveInvoiceForPayment(inv.id, ow, db);
    return inv;
  };
  return { ow, store, ba, cola, tara, osem, mk };
}

test('one payment cannot cover two unrelated suppliers', async () => {
  const db = await freshDb();
  const { ow, ba, cola, osem, mk } = await twoSuppliers(db);
  const a = await mk(cola, 'C-1', 100000);
  const b = await mk(osem, 'O-1', 50000);

  await assert.rejects(
    () => createPayment(
      { bankAccountId: ba.id, method: 'check', checkNumber: '5500', paymentDate: '2026-01-15', invoiceIds: [a.id, b.id] },
      ow, db,
    ),
    /לספקים שונים/,
  );
  // Neither invoice was touched — the whole payment rolled back.
  for (const inv of [a, b]) {
    assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id])).status, 'approved_for_payment');
  }
});

test('a subsidiary and its parent ARE paid together (טרה under קוקה קולה)', async () => {
  const db = await freshDb();
  const { ow, ba, cola, tara, mk } = await twoSuppliers(db);
  const a = await mk(cola, 'C-2', 100000);
  const b = await mk(tara, 'T-2', 50000);

  const pay = await createPayment(
    { bankAccountId: ba.id, method: 'check', checkNumber: '5501', paymentDate: '2026-01-15', invoiceIds: [a.id, b.id] },
    ow, db,
  );
  assert.equal(pay.amount, 150000);
  assert.equal(pay.lines.length, 2);
});

test('the order of selection does not matter — parent first or subsidiary first', async () => {
  const db = await freshDb();
  const { ow, ba, cola, tara, osem, mk } = await twoSuppliers(db);
  const t = await mk(tara, 'T-3', 50000);
  const c = await mk(cola, 'C-3', 100000);
  const o = await mk(osem, 'O-3', 20000);

  const pay = await createPayment(
    { bankAccountId: ba.id, method: 'check', checkNumber: '5502', paymentDate: '2026-01-15', invoiceIds: [t.id, c.id] },
    ow, db,
  );
  assert.equal(pay.amount, 150000);
  // …but a third, unrelated supplier is still refused when the subsidiary was picked first.
  const t2 = await mk(tara, 'T-4', 10000);
  await assert.rejects(
    () => createPayment(
      { bankAccountId: ba.id, method: 'check', checkNumber: '5503', paymentDate: '2026-01-15', invoiceIds: [t2.id, o.id] },
      ow, db,
    ),
    /לספקים שונים/,
  );
});

// --- attaching open invoices from the payment screen -------------------------------------------

test('a payment with money on account offers the supplier\'s open invoices and allocates them', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');
  const { openInvoicesForPayment } = await import('../src/services/allocations.js');

  const db = await freshDb();
  const { ow, store, ba, cola, tara, osem, mk } = await twoSuppliers(db);
  const c = await mk(cola, 'C-9', 100000);
  await mk(osem, 'O-9', 70000); // another supplier — must NOT be offered
  const t = await mk(tara, 'T-9', 30000); // the subsidiary — must be offered

  const adv = await createPayment(
    { bankAccountId: ba.id, method: 'check', checkNumber: '5600', paymentDate: '2026-01-20', supplierId: cola.id, amount: 130000 },
    ow, db,
  );

  const offered = await openInvoicesForPayment(adv.id, db);
  assert.deepEqual(offered.map((i) => i.invoice_number).sort(), ['C-9', 'T-9'], 'the family only');

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `session=${createSession(ow.id)}`;
  try {
    const page = await (await fetch(`${base}/payments/${adv.id}`, { headers: { cookie } })).text();
    assert.match(page, /יתרה על החשבון/);
    assert.match(page, /C-9/);
    assert.ok(!/O-9/.test(page), "another supplier's invoice is not offered");

    const body = new URLSearchParams();
    body.append('invoice_ids', String(c.id));
    body.append('invoice_ids', String(t.id));
    const res = await fetch(`${base}/payments/${adv.id}/allocate`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(res.status, 303);
    assert.deepEqual(await paymentAllocation(adv.id, db), { amount: 130000, allocated: 130000, unallocated: 0 });
    for (const inv of [c, t]) {
      assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id])).status, 'paid');
    }
  } finally {
    server.close();
  }
});

// --- the new-payment screen honours the active store ------------------------------------------

test('/payments/new shows only the active store, and collapses the groups when showing all', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');

  const db = await freshDb();
  const ow = await owner(db);
  const stores = await db.many('SELECT id, name FROM stores ORDER BY id', []);
  assert.ok(stores.length >= 2);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='ספק'", []);

  // One payable invoice in each of the first two stores.
  for (const [n, st] of stores.slice(0, 2).entries()) {
    await createInvoice(
      // Distinct amounts/dates so the R4 near-duplicate warning doesn't fire between the two.
      { supplierId: sup.id, storeId: st.id, invoiceNumber: `ST-${n}`, invoiceDate: `2026-0${n + 1}-10`, amountBeforeVat: 10000 + n * 7777, vatAmount: 0, docType: 'tax_invoice' },
      ow, db,
    );
    const inv = await db.one('SELECT id FROM invoices WHERE invoice_number = ?', [`ST-${n}`]);
    await approveInvoiceForPayment(inv.id, ow, db);
  }

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `session=${createSession(ow.id)}`;
  try {
    // No active store → both stores' invoices, and the groups start collapsed (no `open`).
    const all = await (await fetch(`${base}/payments/new`, { headers: { cookie } })).text();
    assert.match(all, /ST-0/);
    assert.match(all, /ST-1/);
    assert.ok(!/<details data-accordion="paygrp" open>/.test(all), 'groups collapsed when showing every store');

    // Switch the active store → only that store's invoices, and its group is open.
    const withStore = await (await fetch(`${base}/payments/new`, {
      headers: { cookie: `${cookie}; ap_store=${stores[0].id}` },
    })).text();
    assert.match(withStore, /ST-0/);
    assert.ok(!/ST-1/.test(withStore), 'the other store is filtered out');
    assert.match(withStore, /<details data-accordion="paygrp" open>/);
    assert.match(withStore, /החנות הפעילה בלבד/);
  } finally {
    server.close();
  }
});

test('"save and add another" returns to the form instead of opening the payment', async () => {
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
    const post = (checkNumber, addAnother) => {
      const body = new URLSearchParams({
        bank_account_id: String(ba.id),
        advance_supplier_id: String(landlord.id),
        advance_amount: '5000',
        method: 'check',
        check_number: checkNumber,
        payment_date: '2026-01-01',
      });
      if (addAnother) body.set('add_another', '1');
      return fetch(`${base}/payments`, {
        method: 'POST', redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    };

    const again = await post('9101', true);
    assert.equal(again.status, 303);
    assert.equal(again.headers.get('location'), '/payments/new?added=1');

    const done = await post('9102', false);
    assert.match(done.headers.get('location'), /^\/payments\/\d+$/);

    // Both checks were really recorded — 12 rent checks in a row is the point of the button.
    const n = await db.one("SELECT COUNT(*) AS n FROM payments WHERE supplier_id = ?", [landlord.id]);
    assert.equal(Number(n.n), 2);

    const form = await (await fetch(`${base}/payments/new?added=1`, { headers: { cookie } })).text();
    assert.match(form, /התשלום נרשם. אפשר להזין את הבא/);
  } finally {
    server.close();
  }
});

// --- splitting one invoice across several checks, from the new-invoice screen ------------------

test('"שמור וצור תשלום נוסף" pays an invoice with three checks, one at a time', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');

  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('בעל הנכס', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='בעל הנכס'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'SPLIT-1', invoiceDate: '2026-03-01', amountBeforeVat: 1500000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='SPLIT-1'", []);
  await approveInvoiceForPayment(inv.id, ow, db);

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `session=${createSession(ow.id)}`;

  const payBatch = (checkNumber, amount, addMore) => {
    const body = new URLSearchParams({
      supplier_id: String(sup.id),
      store_id: String(store.id),
      pay_method: 'check',
      check_number: checkNumber,
      check_due_date: '2026-03-10',
    });
    body.append('invoice_ids', String(inv.id));
    if (amount != null) body.set('pay_amount', amount);
    if (addMore) body.set('add_more', '1');
    return fetch(`${base}/invoices/pay-batch`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  };

  try {
    // Check 1 of 3 — ₪5,000 of a ₪15,000 invoice, staying on the form.
    let res = await payBatch('3001', '5000', true);
    assert.equal(res.status, 303);
    let loc = res.headers.get('location');
    assert.match(loc, /^\/invoices\/new\?/);
    const q1 = new URLSearchParams(loc.split('?')[1]);
    assert.equal(q1.get('pick'), String(inv.id), 'the same invoice stays selected');
    assert.match(q1.get('partial'), /10000\.00 ₪/);
    assert.deepEqual(await invoiceAllocation(inv.id, db), { total: 1500000, allocated: 500000, open: 1000000 });
    assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id])).status, 'approved_for_payment');

    // Check 2 — another ₪5,000, still on the form.
    res = await payBatch('3002', '5000', true);
    const q2 = new URLSearchParams(res.headers.get('location').split('?')[1]);
    assert.match(q2.get('partial'), /5000\.00 ₪/);
    assert.equal((await invoiceAllocation(inv.id, db)).open, 500000);

    // Check 3 — the closing one, no amount: it takes the whole remaining balance.
    res = await payBatch('3003', null, false);
    assert.match(res.headers.get('location'), /^\/invoices\?/);
    assert.deepEqual(await invoiceAllocation(inv.id, db), { total: 1500000, allocated: 1500000, open: 0 });
    assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id])).status, 'paid');

    // Three real checks, each carrying its own share.
    const pays = await db.many(
      `SELECT p.check_number, p.amount FROM payments p ORDER BY p.id`,
      [],
    );
    assert.deepEqual(pays.map((p) => p.check_number), ['3001', '3002', '3003']);
    assert.deepEqual(pays.map((p) => Number(p.amount)), [500000, 500000, 500000]);
  } finally {
    server.close();
  }
});

test('a split payment never takes more than the invoice still owes, and cannot overpay', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');

  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='ספק'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'SPLIT-2', invoiceDate: '2026-03-01', amountBeforeVat: 100000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='SPLIT-2'", []);
  await approveInvoiceForPayment(inv.id, ow, db);

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `session=${createSession(ow.id)}`;
  try {
    const body = new URLSearchParams({
      supplier_id: String(sup.id), store_id: String(store.id),
      pay_method: 'check', check_number: '4001', check_due_date: '2026-03-10',
      pay_amount: '9999', // way over the ₪1,000 invoice
    });
    body.append('invoice_ids', String(inv.id));
    await fetch(`${base}/invoices/pay-batch`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    // Capped at the invoice, not the typed amount.
    const pay = await db.one("SELECT amount FROM payments WHERE check_number='4001'", []);
    assert.equal(Number(pay.amount), 100000);
    assert.equal((await invoiceAllocation(inv.id, db)).open, 0);

    // Paying again is refused — there is nothing left open.
    const body2 = new URLSearchParams({
      supplier_id: String(sup.id), store_id: String(store.id),
      pay_method: 'check', check_number: '4002', check_due_date: '2026-03-10', pay_amount: '100',
    });
    body2.append('invoice_ids', String(inv.id));
    const res2 = await fetch(`${base}/invoices/pay-batch`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: body2,
    });
    assert.equal(res2.status, 400);
    assert.match(await res2.text(), /כבר משולמות במלואן/);
  } finally {
    server.close();
  }
});

test('the invoice page always shows the allocation rubric while a balance is open', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');

  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='ספק'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'VIS-1', invoiceDate: '2026-03-01', amountBeforeVat: 100000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number='VIS-1'", []);

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `session=${createSession(ow.id)}`;
  try {
    // No advances exist yet — the rubric is still there, explaining itself instead of vanishing.
    const page = await (await fetch(`${base}/invoices/${inv.id}`, { headers: { cookie } })).text();
    assert.match(page, /שייך לתשלומים שכבר בוצעו/);
    assert.match(page, /אין כרגע תשלומים פתוחים/);
    assert.match(page, /תשלום על החשבון/);
  } finally {
    server.close();
  }
});
