import { getDb } from '../db/index.js';
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
export function listStructure(db = getDb()) {
  const companies = db.prepare('SELECT * FROM companies ORDER BY name').all();
  const stores = db
    .prepare(
      `SELECT st.*, ba.id AS account_id, ba.bank_name, ba.branch, ba.account_number, ba.display_name
         FROM stores st LEFT JOIN bank_accounts ba ON ba.store_id = st.id
        ORDER BY st.name`,
    )
    .all();
  return companies.map((c) => ({
    ...c,
    stores: stores.filter((s) => s.company_id === c.id),
  }));
}

export function createCompany({ name, companyType = 'ltd', taxId = null }, actor, db = getDb()) {
  requireOwner(actor);
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new RuleError('VALIDATION', 'שם חברה חובה');
  const tax = validateTaxId(taxId);
  const info = db
    .prepare('INSERT INTO companies (name, company_type, tax_id) VALUES (?, ?, ?)')
    .run(trimmed, companyType || 'ltd', tax);
  logAction({ userId: actor.id, action: 'company.create', entityType: 'company', entityId: info.lastInsertRowid, details: { name: trimmed } }, db);
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(info.lastInsertRowid);
}

export function updateCompany(id, { name, taxId }, actor, db = getDb()) {
  requireOwner(actor);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!company) throw new NotFoundError(`חברה ${id} לא נמצאה`);
  const newName = name?.trim() || company.name;
  const newTax = taxId === undefined ? company.tax_id : validateTaxId(taxId);
  db.prepare('UPDATE companies SET name = ?, tax_id = ? WHERE id = ?').run(newName, newTax, id);
  logAction({ userId: actor.id, action: 'company.update', entityType: 'company', entityId: id }, db);
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

/**
 * Create a store together with its 1:1 bank account.
 * @param {{companyId:number, storeName:string, address?:string, bankName?:string,
 *   branch:string, accountNumber:string, displayName?:string}} input
 */
export function createStoreWithAccount(input, actor, db = getDb()) {
  requireOwner(actor);
  const { companyId, storeName, address = null, bankName = 'הפועלים', branch, accountNumber } = input;

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) throw new NotFoundError(`חברה ${companyId} לא נמצאה`);
  if (!storeName?.trim()) throw new RuleError('VALIDATION', 'שם חנות חובה');
  if (!branch?.trim() || !accountNumber?.trim()) {
    throw new RuleError('VALIDATION', 'סניף ומספר חשבון חובה');
  }

  const displayName =
    input.displayName?.trim() || `${storeName.trim()} · ${bankName} ${branch}-${accountNumber}`;

  const result = db.transaction(() => {
    const storeInfo = db
      .prepare('INSERT INTO stores (company_id, name, address) VALUES (?, ?, ?)')
      .run(companyId, storeName.trim(), address?.trim() || null);
    const storeId = storeInfo.lastInsertRowid;
    db.prepare(
      `INSERT INTO bank_accounts (company_id, store_id, bank_name, branch, account_number, display_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(companyId, storeId, bankName || 'הפועלים', branch.trim(), accountNumber.trim(), displayName);
    logAction({ userId: actor.id, action: 'store.create', entityType: 'store', entityId: storeId, details: { storeName: storeName.trim(), accountNumber: accountNumber.trim() } }, db);
    return storeId;
  })();

  return db.prepare('SELECT * FROM stores WHERE id = ?').get(result);
}

export function updateAccountDisplayName(accountId, displayName, actor, db = getDb()) {
  requireOwner(actor);
  const acct = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId);
  if (!acct) throw new NotFoundError(`חשבון ${accountId} לא נמצא`);
  const name = displayName?.trim();
  if (!name) throw new RuleError('VALIDATION', 'שם תצוגה חובה');
  db.prepare('UPDATE bank_accounts SET display_name = ? WHERE id = ?').run(name, accountId);
  logAction({ userId: actor.id, action: 'account.update', entityType: 'bank_account', entityId: accountId }, db);
  return db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(accountId);
}
