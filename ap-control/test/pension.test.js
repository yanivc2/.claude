import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary } from './helpers.js';
import {
  assess,
  createEmployee,
  listEmployees,
  setPensionOpened,
  terminateEmployee,
  markReleaseSent,
  pensionAlerts,
  pensionSummary,
  getEmployee,
} from '../src/services/pension.js';

test('assess: new employee gets a 6-month deadline, prior-pension gets 3', () => {
  const base = { start_date: '2026-01-01', status: 'active', pension_opened: 0 };
  assert.equal(assess({ ...base, prior_pension: 0 }, '2026-02-01').pension_deadline, '2026-07-01');
  assert.equal(assess({ ...base, prior_pension: 1 }, '2026-02-01').pension_deadline, '2026-04-01');
});

test('assess: overdue when past deadline and not opened', () => {
  const e = assess({ start_date: '2026-01-01', prior_pension: 0, pension_opened: 0, status: 'active' }, '2026-08-01');
  assert.equal(e.risk.level, 'overdue');
});

test('assess: due_soon inside the warn window, ok when opened', () => {
  const soon = assess({ start_date: '2026-01-01', prior_pension: 0, pension_opened: 0, status: 'active' }, '2026-06-20');
  assert.equal(soon.risk.level, 'due_soon');
  const opened = assess({ start_date: '2026-01-01', prior_pension: 0, pension_opened: 1, status: 'active' }, '2026-08-01');
  assert.equal(opened.risk.level, 'ok');
});

test('assess: terminated employee needs a release notice until sent', () => {
  const pending = assess({ start_date: '2026-01-01', prior_pension: 0, pension_opened: 1, status: 'terminated', release_sent: 0 }, '2026-08-01');
  assert.equal(pending.risk.level, 'release_due');
  const done = assess({ start_date: '2026-01-01', prior_pension: 0, pension_opened: 1, status: 'terminated', release_sent: 1 }, '2026-08-01');
  assert.equal(done.risk.level, 'ok');
});

test('createEmployee + setPensionOpened clears the open obligation', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const e = await createEmployee({ name: 'דנה כהן', startDate: '2026-01-01' }, o, db);
  assert.equal(e.pension_opened, 0);
  const opened = await setPensionOpened(e.id, '2026-03-01', o, db);
  assert.equal(opened.pension_opened, 1);
  assert.equal(opened.pension_opened_date, '2026-03-01');
});

test('terminate requires a valid reason; release can then be marked', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const e = await createEmployee({ name: 'רון', startDate: '2026-01-01' }, o, db);
  await assert.rejects(() => terminateEmployee(e.id, { reason: 'nope' }, o, db), /סיבת/);
  const term = await terminateEmployee(e.id, { date: '2026-07-01', reason: 'dismissed' }, o, db);
  assert.equal(term.status, 'terminated');
  assert.equal(term.termination_reason, 'dismissed');
  // cannot mark release for a still-active employee
  const active = await createEmployee({ name: 'אקטיב', startDate: '2026-01-01' }, o, db);
  await assert.rejects(() => markReleaseSent(active.id, null, o, db), /סיים/);
  const released = await markReleaseSent(e.id, '2026-07-05', o, db);
  assert.equal(released.release_sent, 1);
});

test('pensionAlerts + summary surface only the at-risk employees', async () => {
  const db = await freshDb();
  const o = await owner(db);
  // Overdue (started long ago, not opened).
  await createEmployee({ name: 'חורג', startDate: '2026-01-01' }, o, db);
  // Fine (opened).
  const ok = await createEmployee({ name: 'תקין', startDate: '2026-01-01' }, o, db);
  await setPensionOpened(ok.id, '2026-02-01', o, db);
  const alerts = await pensionAlerts('2026-08-01', db);
  const names = alerts.map((a) => a.name);
  assert.ok(names.includes('חורג'));
  assert.ok(!names.includes('תקין'));
  const s = await pensionSummary('2026-08-01', db);
  assert.equal(s.overdue, 1);
  assert.equal(s.atRisk, 1);
});

test('createEmployee validates name and start date', async () => {
  const db = await freshDb();
  const o = await owner(db);
  await assert.rejects(() => createEmployee({ name: '', startDate: '2026-01-01' }, o, db), /שם/);
  await assert.rejects(() => createEmployee({ name: 'x', startDate: 'bad' }, o, db), /תאריך/);
});
