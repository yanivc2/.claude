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
