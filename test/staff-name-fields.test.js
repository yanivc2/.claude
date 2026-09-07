// ONE RULE FOR EVERY "who" FIELD: a person's name is PICKED from the staff list, never typed.
//
// A typed name matched nothing, so the row was unattributable and the same person appeared under
// three spellings. This suite pins the rule everywhere it applies:
//   • סגירת Z — the counter (מבצע הספירה) is asked once, at the top, and every register in
//     "איזון קופות" inherits it (it used to be typed twice, in two rubrics, and could disagree);
//   • cash-expense "שם" on the Z-closing form AND the Z-report form;
//   • "שם המשלם" / "שולם ע\"י" on a cash payment.
// Everywhere: a name saved before the change (or an employee since removed) stays selectable and
// is flagged, and with no employees at all the form falls back to free text rather than locking up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZClosing, getZClosing, updateZClosing } from '../src/services/zclosing.js';
import { createEmployee } from '../src/services/employees.js';
import { createZReport } from '../src/services/zreports.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { accountForStore } from './helpers.js';

const base = (store, overrides = {}) => ({
  employeeFirst: 'רון', employeeLast: 'לוי', storeId: store.id, zNumber: '910',
  drawerCash: 20000, startedAt: '2026-08-13 09:00', counts: { 100: 2 }, expenses: [],
  ...overrides,
});

const regsOf = (closing) => JSON.parse(closing.registers || '[]');

test('a register saved without a name inherits the closing counter — free-text name', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const id = await createZClosing(
    base(store, { registers: [{ register: '1', storeId: store.id, counts: { 100: 3 } }] }),
    o, x,
  );
  const [reg] = regsOf(await getZClosing(id, x));
  assert.equal(reg.first, 'רון');
  assert.equal(reg.last, 'לוי');
  assert.equal(reg.total, 30000, 'the count itself is unaffected');
});

test('the inherited name is the EMPLOYEE picked at the top, not a stale typed one', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const emp = await createEmployee({ firstName: 'נועה', lastName: 'כהן', phone: '050-1112223' }, o, x);
  const id = await createZClosing(
    base(store, {
      employeeId: emp.id,
      employeeFirst: 'רון', employeeLast: 'לוי', // whatever the old hidden fields carried
      registers: [{ register: '1', storeId: store.id, counts: { 100: 1 } }],
    }),
    o, x,
  );
  const closing = await getZClosing(id, x);
  assert.equal(closing.employee_first, 'נועה');
  assert.deepEqual(
    regsOf(closing).map((r) => `${r.first} ${r.last}`),
    ['נועה כהן'],
    'the register shows who actually counted, not the free-text leftovers',
  );
});

test('a legacy register that carries its own counter name keeps it on re-save', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const id = await createZClosing(
    base(store, {
      registers: [
        { first: 'דנה', last: 'מזרחי', register: '1', storeId: store.id, counts: { 100: 1 } },
        { register: '2', storeId: store.id, counts: { 100: 2 } },
      ],
    }),
    o, x,
  );
  const regs = regsOf(await getZClosing(id, x));
  assert.equal(`${regs[0].first} ${regs[0].last}`, 'דנה מזרחי', 'its own name is not overwritten');
  assert.equal(`${regs[1].first} ${regs[1].last}`, 'רון לוי', 'the nameless one inherits');

  // Editing (the edit form round-trips the legacy name through hidden fields) keeps it.
  await updateZClosing(
    id,
    base(store, {
      registers: [
        { first: 'דנה', last: 'מזרחי', register: '1', storeId: store.id, counts: { 100: 1 } },
        { register: '2', storeId: store.id, counts: { 100: 5 } },
      ],
    }),
    o, x,
  );
  const after = regsOf(await getZClosing(id, x));
  assert.equal(`${after[0].first} ${after[0].last}`, 'דנה מזרחי');
  assert.equal(after[1].total, 50000);
});

test('the closing form asks for the counter once, above איזון קופות, and never per register', async () => {
  const x = await freshDb();
  const o = await owner(x);
  await createEmployee({ firstName: 'נועה', lastName: 'כהן', phone: '050-9998887' }, o, x);
  const server = createApp().listen(0);
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/zclosing`;
    const html = await (await fetch(url, { headers: { cookie: `session=${encodeURIComponent(createSession(o.id))}` } })).text();

    const counter = html.indexOf('עובד (מבצע הספירה)');
    const balancing = html.indexOf('איזון קופות');
    assert.ok(counter > -1 && balancing > -1);
    assert.ok(counter < balancing, 'the counter is asked before the register balancing, not after');

    assert.ok(!/name="reg_first\[\]"/.test(html), 'no per-register first-name field');
    assert.ok(!/name="reg_last\[\]"/.test(html), 'no per-register last-name field');
    assert.ok(html.includes('reg-counter'), 'each register shows who counted instead');

    // "שם" on a cash expense is a pick from the employee list, never a free-text box.
    assert.ok(html.includes('class="cx-payer js-combo"'), 'the payer field is the employee picker');
    assert.ok(!/<input name="payer_name"/.test(html), 'no free-text payer input while employees exist');
    assert.ok(html.includes('נועה כהן'), 'the employee is offered by name');
  } finally {
    server.close();
  }
});

test('with no employees at all the closing form still works (free-text fallback)', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const server = createApp().listen(0);
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/zclosing`;
    const html = await (await fetch(url, { headers: { cookie: `session=${encodeURIComponent(createSession(o.id))}` } })).text();
    assert.ok(html.includes('name="employee_first"'), 'falls back to typing the counter');
    assert.ok(/<input name="payer_name"/.test(html), 'and to typing the expense name');
    assert.ok(!/name="reg_first\[\]"/.test(html), 'still never asks for a name per register');
  } finally {
    server.close();
  }
});

// The Z REPORT form (`views/reports/_zform.ejs`) carries the same cash-expenses rubric, so it
// follows the same rule — otherwise "שם" means a picked employee on one page and free text on the
// other, and the same expense reads differently depending on where it was entered.
test('the Z-report form uses the same employee picker for a cash expense name', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  await createEmployee({ firstName: 'איתי', lastName: 'ברק', phone: '050-4445556' }, o, x);
  const zr = await createZReport(
    { storeId: store.id, zNumber: '960', zDate: '2026-08-20', dailyTotal: 100000, drawerCash: 100000 },
    o, x,
  );
  const server = createApp().listen(0);
  await once(server, 'listening');
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const headers = { cookie: `session=${encodeURIComponent(createSession(o.id))}` };
    for (const path of ['/reports/zreports', `/reports/zreports/${zr.id}`]) {
      const html = await (await fetch(root + path, { headers })).text();
      assert.ok(html.includes('class="cx-payer js-combo"'), `${path}: the payer field is the employee picker`);
      assert.ok(!/<input name="payer_name"/.test(html), `${path}: no free-text payer input`);
      assert.ok(html.includes('איתי ברק'), `${path}: the employee is offered by name`);
    }
  } finally {
    server.close();
  }
});

// Cash PAYMENTS carry the same idea: "שם המשלם" / "שולם ע\"י" is the member of staff who handed
// over the money, so it is picked from the staff list too — one rule for every name field.
test('cash payment forms pick "שם המשלם" from the staff list, and keep a legacy typed name', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const acct = await accountForStore(x, store.id);
  await createEmployee({ firstName: 'שירה', lastName: 'אבידן', phone: '050-7778889' }, o, x);

  // A payment recorded BEFORE this change carries a free-text payer that is not an employee.
  await x.run("INSERT INTO suppliers (name, status) VALUES ('ספק מזומן', 'approved')", []);
  const sup = await x.one("SELECT * FROM suppliers WHERE name='ספק מזומן'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'CASH-1', invoiceDate: '2026-08-02', amountBeforeVat: 5000, vatAmount: 0, docType: 'tax_invoice' },
    o, x,
  );
  const inv = await x.one("SELECT id FROM invoices WHERE invoice_number='CASH-1'", []);
  await approveInvoiceForPayment(inv.id, o, x);
  const pay = await createPayment(
    { bankAccountId: acct.id, method: 'cash', payerName: 'מישהו ישן', paymentDate: '2026-08-03', invoiceIds: [inv.id] },
    o, x,
  );

  const server = createApp().listen(0);
  await once(server, 'listening');
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const headers = { cookie: `session=${encodeURIComponent(createSession(o.id))}` };

    const newHtml = await (await fetch(`${root}/payments/new`, { headers })).text();
    assert.ok(!/<input name="payer_name"/.test(newHtml), 'no free-text payer input on /payments/new');
    assert.ok(newHtml.includes('שירה אבידן'), 'the staff list is offered');

    const editHtml = await (await fetch(`${root}/payments/${pay.id}/edit`, { headers })).text();
    assert.ok(!/<input name="payer_name"/.test(editHtml), 'no free-text payer input on the edit form');
    assert.ok(editHtml.includes('מישהו ישן'), 'the legacy name is still selectable, not blanked');
    assert.ok(editHtml.includes('לא ברשימת העובדים'), 'and it is flagged as no longer on staff');
  } finally {
    server.close();
  }
});
