import { getExecutor, tx } from '../db/adapter.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

// Manage the org structure from the UI (§2 — "must allow adding a store/account easily").
// Store <-> bank account is 1:1, so a store is always created together with its account.
// All mutations are owner-only (structural configuration).

function requireOwner(actor) {
  if (!actor || actor.role !== 'owner') throw new AuthError('ניהול מבנה ארגוני — בעלים בלבד');
}

function validateTaxId(taxId) {
  const t = (taxId ?? '').trim();
  if (t === '') return null;
  if (!/^\d{9}$/.test(t)) throw new RuleError('VALIDATION', 'ח.פ. חייב להיות 9 ספרות');
  return t;
}

/** Nested structure for the settings view: companies -> stores -> account. */
export async function listStructure(x = getExecutor()) {
  const companies = await x.many('SELECT * FROM companies ORDER BY name', []);
  const stores = await x.many(
    `SELECT st.*, ba.id AS account_id, ba.bank_name, ba.branch, ba.account_number, ba.display_name
       FROM stores st LEFT JOIN bank_accounts ba ON ba.store_id = st.id
      ORDER BY st.name`,
    [],
  );
  return companies.map((c) => ({
    ...c,
    stores: stores.filter((s) => s.company_id === c.id),
  }));
}

export async function createCompany({ name, companyType = 'ltd', taxId = null }, actor, x = getExecutor()) {
  requireOwner(actor);
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new RuleError('VALIDATION', 'שם חברה חובה');
  const tax = validateTaxId(taxId);
  const info = await x.run('INSERT INTO companies (name, company_type, tax_id) VALUES (?, ?, ?)', [
    trimmed,
    companyType || 'ltd',
    tax,
  ]);
  await logAction({ userId: actor.id, action: 'company.create', entityType: 'company', entityId: info.lastInsertRowid, details: { name: trimmed } }, x);
  return x.one('SELECT * FROM companies WHERE id = ?', [info.lastInsertRowid]);
}

export async function updateCompany(id, { name, taxId }, actor, x = getExecutor()) {
  requireOwner(actor);
  const company = await x.one('SELECT * FROM companies WHERE id = ?', [id]);
  if (!company) throw new NotFoundError(`חברה ${id} לא נמצאה`);
  const newName = name?.trim() || company.name;
  const newTax = taxId === undefined ? company.tax_id : validateTaxId(taxId);
  await x.run('UPDATE companies SET name = ?, tax_id = ? WHERE id = ?', [newName, newTax, id]);
  await logAction({ userId: actor.id, action: 'company.update', entityType: 'company', entityId: id }, x);
  return x.one('SELECT * FROM companies WHERE id = ?', [id]);
}

/**
 * Create a store together with its 1:1 bank account.
 * @param {{companyId:number, storeName:string, address?:string, bankName?:string,
 *   branch:string, accountNumber:string, displayName?:string}} input
 */
export async function createStoreWithAccount(input, actor, x = getExecutor()) {
  requireOwner(actor);
  const { companyId, storeName, address = null, bankName = 'הפועלים', branch, accountNumber } = input;

  const company = await x.one('SELECT * FROM companies WHERE id = ?', [companyId]);
  if (!company) throw new NotFoundError(`חברה ${companyId} לא נמצאה`);
  if (!storeName?.trim()) throw new RuleError('VALIDATION', 'שם חנות חובה');
  if (!branch?.trim() || !accountNumber?.trim()) {
    throw new RuleError('VALIDATION', 'סניף ומספר חשבון חובה');
  }

  const displayName =
    input.displayName?.trim() || `${storeName.trim()} · ${bankName} ${branch}-${accountNumber}`;

  const storeId = await tx(async (t) => {
    const storeInfo = await t.run('INSERT INTO stores (company_id, name, address) VALUES (?, ?, ?)', [
      companyId,
      storeName.trim(),
      address?.trim() || null,
    ]);
    const sid = storeInfo.lastInsertRowid;
    await t.run(
      `INSERT INTO bank_accounts (company_id, store_id, bank_name, branch, account_number, display_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [companyId, sid, bankName || 'הפועלים', branch.trim(), accountNumber.trim(), displayName],
    );
    await logAction({ userId: actor.id, action: 'store.create', entityType: 'store', entityId: sid, details: { storeName: storeName.trim(), accountNumber: accountNumber.trim() } }, t);
    return sid;
  });

  return x.one('SELECT * FROM stores WHERE id = ?', [storeId]);
}

/**
 * Delete a store together with its 1:1 bank account (owner only). Refused if any transactional
 * data references the store or its account (invoices / Z reports / deposits / register closings /
 * sales / payments / bank transactions) — history is never silently destroyed. Intended for
 * cleaning up a store created by mistake. Supplier→store assignments are just cleaned up.
 */
export async function deleteStore(storeId, actor, x = getExecutor()) {
  requireOwner(actor);
  const store = await x.one('SELECT * FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);

  const guards = [
    ['invoices', 'חשבוניות'],
    ['z_reports', 'דוחות Z'],
    ['deposits', 'הצהרות הפקדה'],
    ['z_closings', 'סגירות Z'],
    ['sales_entries', 'רשומות מכירה'],
  ];
  for (const [table, label] of guards) {
    const row = await x.one(`SELECT COUNT(*) AS n FROM ${table} WHERE store_id = ?`, [storeId]);
    if (row && row.n > 0) throw new RuleError('IN_USE', `לחנות "${store.name}" יש ${row.n} ${label} — לא ניתן למחוק.`);
  }
  const acct = await x.one('SELECT id FROM bank_accounts WHERE store_id = ?', [storeId]);
  if (acct) {
    const p = await x.one('SELECT COUNT(*) AS n FROM payments WHERE bank_account_id = ?', [acct.id]);
    if (p && p.n > 0) throw new RuleError('IN_USE', `לחנות "${store.name}" יש ${p.n} תשלומים — לא ניתן למחוק.`);
    const t = await x.one('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?', [acct.id]);
    if (t && t.n > 0) throw new RuleError('IN_USE', `לחנות "${store.name}" יש ${t.n} תנועות בנק — לא ניתן למחוק.`);
  }

  await tx(async (t) => {
    await t.run('DELETE FROM supplier_stores WHERE store_id = ?', [storeId]);
    if (acct) await t.run('DELETE FROM bank_accounts WHERE store_id = ?', [storeId]);
    await t.run('DELETE FROM stores WHERE id = ?', [storeId]);
    await logAction({ userId: actor.id, action: 'store.delete', entityType: 'store', entityId: storeId, details: { name: store.name } }, t);
  });
}

export async function updateAccountDisplayName(accountId, displayName, actor, x = getExecutor()) {
  requireOwner(actor);
  const acct = await x.one('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
  if (!acct) throw new NotFoundError(`חשבון ${accountId} לא נמצא`);
  const name = displayName?.trim();
  if (!name) throw new RuleError('VALIDATION', 'שם תצוגה חובה');
  await x.run('UPDATE bank_accounts SET display_name = ? WHERE id = ?', [name, accountId]);
  await logAction({ userId: actor.id, action: 'account.update', entityType: 'bank_account', entityId: accountId }, x);
  return x.one('SELECT * FROM bank_accounts WHERE id = ?', [accountId]);
}
