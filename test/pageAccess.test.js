import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canViewPage, firstAllowedPath } from '../src/lib/permissions.js';

const owner = { role: 'owner' };
const u = (perms) => ({ role: 'secretary', permissions: JSON.stringify(perms) });

test('canViewPage: owner sees every page', () => {
  assert.equal(canViewPage(owner, 'nav_dashboard'), true);
  assert.equal(canViewPage(owner, 'nav_profitability'), true);
});

test('canViewPage: no page permissions => full access (non-breaking)', () => {
  assert.equal(canViewPage(u([]), 'nav_dashboard'), true);
  // action-only permissions must NOT restrict page access
  assert.equal(canViewPage(u(['approve_payment']), 'nav_invoices'), true);
});

test('canViewPage: once page permissions are set, access is limited to exactly those', () => {
  const user = u(['nav_profitability', 'nav_dashboard']);
  assert.equal(canViewPage(user, 'nav_profitability'), true);
  assert.equal(canViewPage(user, 'nav_dashboard'), true);
  assert.equal(canViewPage(user, 'nav_invoices'), false);
  assert.equal(canViewPage(user, 'nav_payments'), false);
});

test('firstAllowedPath returns the first page the user may open', () => {
  assert.equal(firstAllowedPath(owner), '/');
  assert.equal(firstAllowedPath(u([])), '/'); // unrestricted -> dashboard
  assert.equal(firstAllowedPath(u(['nav_profitability'])), '/reports/profitability');
  assert.equal(firstAllowedPath(u(['nav_suppliers'])), '/suppliers');
});

test('new granular action permissions exist and are strictly enforced', async () => {
  const { userCan, PERMISSIONS, ROLE_PRESETS } = await import('../src/lib/permissions.js');
  const keys = PERMISSIONS.map((p) => p.key);
  for (const k of ['edit_invoice', 'delete_zreport', 'manage_deposits', 'import_bank']) {
    assert.ok(keys.includes(k), `catalog has ${k}`);
    assert.equal(userCan(u([]), k), false);            // not granted → denied
    assert.equal(userCan(u([k]), k), true);            // granted → allowed
    assert.equal(userCan(owner, k), true);             // owner → always
  }
  // store-manager preset grants the everyday actions
  const sm = ROLE_PRESETS.find((r) => r.key === 'store_manager');
  assert.ok(sm.perms.includes('edit_invoice') && sm.perms.includes('manage_deposits'));
});
