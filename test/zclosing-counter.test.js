// The counter (מבצע הספירה) is asked ONCE, at the top of the closing form, and every register in
// "איזון קופות" inherits it — the same name used to be typed twice, in two rubrics, and the two
// could disagree. Cash-expense "שם" is likewise a pick from the employee list, not free text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZClosing, getZClosing, updateZClosing } from '../src/services/zclosing.js';
import { createEmployee } from '../src/services/employees.js';

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
