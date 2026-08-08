import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathAllowedForRestricted, firstAllowedPath, canViewPage } from '../src/lib/permissions.js';
import { freshDb, owner as ownerRow, firstStore } from './helpers.js';
import { createZClosing, listZClosings, israelNow } from '../src/services/zclosing.js';
import { toAgorot } from '../src/lib/money.js';

const owner = { role: 'owner' };
const u = (perms) => ({ role: 'secretary', permissions: JSON.stringify(perms) });

// The register-closer: a user whose ONLY page permission is nav_zclosing.
const closer = u(['nav_zclosing']);

test('register-closer may reach ONLY /zclosing (+ own account), nothing else', () => {
  assert.equal(firstAllowedPath(closer), '/zclosing');
  // allowed
  assert.equal(pathAllowedForRestricted(closer, '/zclosing'), true);
  assert.equal(pathAllowedForRestricted(closer, '/account'), true);
  assert.equal(pathAllowedForRestricted(closer, '/account/password'), true);
  assert.equal(pathAllowedForRestricted(closer, '/logout'), true);
  // every sensitive path is denied — including detail views, CSV exports, settings, approvals
  for (const p of [
    '/', '/invoices', '/invoices/5', '/payments', '/payments/9',
    '/reports/zreports', '/reports/zreports/3', '/reports/zreports/3/image',
    '/reports/deposits/1/delete', '/reports/lookup.csv', '/reports/outstanding.csv',
    '/reports/profitability', '/reports/profitability.csv', '/reconciliation',
    '/suppliers', '/suppliers/contacts', '/audit', '/approvals', '/settings',
  ]) {
    assert.equal(pathAllowedForRestricted(closer, p), false, `must deny ${p}`);
  }
});

test('owner and unrestricted users are unaffected by the firewall helper', () => {
  // canViewPage keeps the legacy non-breaking behavior for unrestricted users
  assert.equal(canViewPage(owner, 'nav_zclosing'), true);
  assert.equal(canViewPage(u([]), 'nav_invoices'), true); // unrestricted → full
  assert.equal(canViewPage(closer, 'nav_invoices'), false); // restricted closer → no
});

test('a restricted user with several pages may reach exactly those (+ their sub-routes)', () => {
  const clerk = u(['nav_payments', 'nav_zreports']);
  assert.equal(pathAllowedForRestricted(clerk, '/payments'), true);
  assert.equal(pathAllowedForRestricted(clerk, '/reports/zreports/7'), true);
  assert.equal(pathAllowedForRestricted(clerk, '/reports/deposits/2/deposited'), true); // shared
  assert.equal(pathAllowedForRestricted(clerk, '/invoices'), false);
  assert.equal(pathAllowedForRestricted(clerk, '/settings'), false);
  assert.equal(pathAllowedForRestricted(clerk, '/reports/profitability'), false);
});

test('createZClosing computes totals server-side and stores Israel-time end', async () => {
  const db = await freshDb();
  const ow = await ownerRow(db);
  await firstStore(db);
  const id = await createZClosing(
    {
      employeeFirst: 'דנה', employeeLast: 'כהן', startedAt: '2026-08-06 18:00',
      counts: { '200': 2, '100': 1, '0_5': 4 }, // 400 + 100 + 2.00 = 502.00
      expenses: [{ desc: 'קפה', amount: toAgorot('15') }, { desc: '', amount: 0 }],
    },
    ow, db,
  );
  const rows = await listZClosings({}, db);
  const c = rows.find((r) => r.id === id);
  assert.equal(c.total_cash, toAgorot('502'));
  assert.equal(c.total_expenses, toAgorot('15'));
  assert.equal(c.grand_total, toAgorot('517'));
  assert.equal(c.employee_first, 'דנה');
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(c.ended_at)); // Israel-time stamp
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(israelNow()));
});

test('createZClosing requires a first and last name', async () => {
  const db = await freshDb();
  const ow = await ownerRow(db);
  await assert.rejects(() => createZClosing({ employeeFirst: 'רק', employeeLast: '', counts: {}, expenses: [] }, ow, db), /שם/);
});
