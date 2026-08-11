import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canViewPage, firstAllowedPath, pathAllowedForRestricted } from '../src/lib/permissions.js';

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

// ---- צילום חשבוניות + מוצרים (stage 5) ----

test('a nav_scan-only user is firewalled to the scan pages', () => {
  const scanner = u(['nav_scan']);
  assert.equal(canViewPage(scanner, 'nav_scan'), true);
  assert.equal(canViewPage(scanner, 'nav_invoices'), false);
  assert.equal(canViewPage(scanner, 'nav_products'), false);
  // every /scan path (capture, one draft, its images, the pending list) is reachable…
  for (const p of ['/scan', '/scan/pending', '/scan/12', '/scan/12/image/0', '/scan/12/status.json']) {
    assert.equal(pathAllowedForRestricted(scanner, p), true, p);
  }
  // …and nothing else is.
  for (const p of ['/invoices', '/invoices/5', '/payments', '/products', '/']) {
    assert.equal(pathAllowedForRestricted(scanner, p), false, p);
  }
  assert.equal(firstAllowedPath(scanner), '/scan');
});

test('a nav_products-only user reaches only the catalog', () => {
  const cat = u(['nav_products']);
  assert.equal(canViewPage(cat, 'nav_products'), true);
  assert.equal(pathAllowedForRestricted(cat, '/products'), true);
  assert.equal(pathAllowedForRestricted(cat, '/products/7'), true);
  assert.equal(pathAllowedForRestricted(cat, '/scan'), false);
  assert.equal(firstAllowedPath(cat), '/products');
});

test('the new pages are appended, so existing roles keep their landing page', async () => {
  const { NAV_PAGES, PERMISSIONS, ROLE_PRESETS } = await import('../src/lib/permissions.js');
  const keys = NAV_PAGES.map((p) => p.key);
  assert.deepEqual(keys.slice(-2), ['nav_scan', 'nav_products']); // appended at the END
  for (const k of ['nav_scan', 'nav_products']) {
    assert.ok(PERMISSIONS.some((p) => p.key === k && p.group === 'עמודים'), `catalog has ${k}`);
  }
  // landing pages of the pre-existing roles are unchanged
  assert.equal(firstAllowedPath(u(['nav_zclosing'])), '/zclosing');
  assert.equal(firstAllowedPath(u(['nav_invoices', 'nav_scan'])), '/invoices');

  const scannerPreset = ROLE_PRESETS.find((r) => r.key === 'invoice_scanner');
  assert.deepEqual(scannerPreset.perms, ['nav_scan']);
  const secretary = ROLE_PRESETS.find((r) => r.key === 'secretary');
  assert.ok(secretary.perms.includes('nav_scan'));
  assert.equal(firstAllowedPath(u(secretary.perms)), '/'); // still lands on the dashboard
  const sm = ROLE_PRESETS.find((r) => r.key === 'store_manager');
  assert.ok(sm.perms.includes('nav_scan') && sm.perms.includes('nav_products'));
});
