import { getExecutor } from '../db/adapter.js';

// Per-user company access (הפרדת חברות). An owner sees everything; a non-owner sees only the
// companies granted in user_companies. `authorizedCompanyIds` returns null to mean "all"
// (no filter), or an array of company ids (possibly empty → sees nothing).

/** Raw company-id grants for a user (from user_companies). */
export async function getUserCompanyIds(userId, x = getExecutor()) {
  const rows = await x.many('SELECT company_id FROM user_companies WHERE user_id = ?', [userId]);
  return rows.map((r) => Number(r.company_id));
}

/** null = all companies (owner); otherwise the array the non-owner is scoped to. */
export async function authorizedCompanyIds(user, x = getExecutor()) {
  if (!user) return [];
  if (user.role === 'owner') return null;
  const direct = await getUserCompanyIds(user.id, x);
  // Store grants imply their parent company, so a user granted only specific stores still passes
  // the existing company-scoped queries (dashboard stats, etc.). Union keeps company-only grants
  // unchanged and only widens for users who also hold per-store grants. Guarded: before the owner
  // runs the DB upgrade the user_stores table may not exist yet — degrade to direct grants only.
  let viaStores = [];
  try {
    viaStores = await x.many(
      'SELECT DISTINCT s.company_id FROM user_stores us JOIN stores s ON s.id = us.store_id WHERE us.user_id = ?',
      [user.id],
    );
  } catch { viaStores = []; }
  return [...new Set([...direct, ...viaStores.map((r) => Number(r.company_id))])];
}

// ---- Per-user STORE access (הרשאה פר-חנות) — finer than company grants. --------------------

/** Raw store-id grants for a user (from user_stores). [] if the table doesn't exist yet (pre-upgrade). */
export async function getUserStoreIds(userId, x = getExecutor()) {
  try {
    const rows = await x.many('SELECT store_id FROM user_stores WHERE user_id = ?', [userId]);
    return rows.map((r) => Number(r.store_id));
  } catch {
    return [];
  }
}

/**
 * null = all stores (owner). Otherwise the store-id array the non-owner may see:
 *   • if they hold explicit user_stores grants → exactly those stores;
 *   • else → every store within their granted companies (backward compatible with company-only
 *     setups). Empty array = sees no store.
 */
export async function authorizedStoreIds(user, x = getExecutor()) {
  if (!user) return [];
  if (user.role === 'owner') return null;
  const storeGrants = await getUserStoreIds(user.id, x);
  if (storeGrants.length) return storeGrants;
  const companyIds = await getUserCompanyIds(user.id, x);
  if (!companyIds.length) return [];
  const rows = await x.many(
    `SELECT id FROM stores WHERE company_id IN (${companyIds.map(() => '?').join(',')})`,
    companyIds,
  );
  return rows.map((r) => Number(r.id));
}

/** Replace a user's store grants (owner action). */
export async function setUserStores(userId, storeIds, x = getExecutor()) {
  const ids = [...new Set((storeIds || []).map(Number).filter(Boolean))];
  await x.run('DELETE FROM user_stores WHERE user_id = ?', [userId]);
  for (const sid of ids) {
    await x.run('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)', [userId, sid]);
  }
  return ids;
}

/** The full store×user grant map for the settings matrix. Map<userId, Set<storeId>>. */
export async function storeGrantMatrix(x = getExecutor()) {
  const rows = await x.many('SELECT user_id, store_id FROM user_stores', []);
  const byUser = new Map();
  for (const r of rows) {
    const uid = Number(r.user_id);
    if (!byUser.has(uid)) byUser.set(uid, new Set());
    byUser.get(uid).add(Number(r.store_id));
  }
  return byUser;
}

/**
 * The stores a user may choose in the active-store picker — each with company name for grouping.
 * Owner → all stores. Non-owner → their authorized set (empty if none).
 */
export async function availableStoresFor(user, x = getExecutor()) {
  const ids = await authorizedStoreIds(user, x);
  let sql = `SELECT s.id, s.name, s.company_id, c.name AS company_name
               FROM stores s JOIN companies c ON c.id = s.company_id`;
  const params = [];
  if (ids != null) {
    if (!ids.length) return [];
    sql += ` WHERE s.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  sql += ' ORDER BY c.name, s.name';
  return x.many(sql, params);
}

/** Replace a user's company grants (owner action). */
export async function setUserCompanies(userId, companyIds, x = getExecutor()) {
  const ids = [...new Set((companyIds || []).map(Number).filter(Boolean))];
  await x.run('DELETE FROM user_companies WHERE user_id = ?', [userId]);
  for (const cid of ids) {
    await x.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [userId, cid]);
  }
  return ids;
}

/**
 * Build a SQL fragment that restricts `colExpr` (a company-id column/expression) to the
 * authorized set. Returns { sql, params }. When companyIds is null (owner/all) the fragment
 * is empty. When it's an empty array, it forces an impossible match (sees nothing).
 */
export function scopeClause(companyIds, colExpr) {
  // Tolerate the full req.scope object — use its companyIds — so a route can pass req.scope to a
  // company-only query without breaking (the store dimension is simply ignored here; use
  // scopeWhere when you also want a store filter). Arrays / null behave exactly as before.
  if (companyIds != null && !Array.isArray(companyIds) && typeof companyIds === 'object') {
    companyIds = companyIds.companyIds ?? null;
  }
  if (companyIds == null) return { sql: '', params: [] };
  if (companyIds.length === 0) return { sql: ` AND 1 = 0`, params: [] };
  const ph = companyIds.map(() => '?').join(',');
  return { sql: ` AND ${colExpr} IN (${ph})`, params: [...companyIds] };
}

// Accept either the historical `companyIds` shape (array / null) or the full req.scope object
// { companyIds, storeIds }. Array/null → company-only (store filter off), for back-compat with the
// many callers (and tests) that pass companyIds directly.
export function normalizeScope(scope) {
  if (scope == null) return { companyIds: null, storeIds: null };
  if (Array.isArray(scope)) return { companyIds: scope, storeIds: null };
  return { companyIds: scope.companyIds ?? null, storeIds: scope.storeIds ?? null };
}

/**
 * Combined company + store WHERE fragment. `scope` may be a companyIds array/null (store filter
 * off) or a req.scope object { companyIds, storeIds }. Emits ` AND <companyCol> IN (...)` and, when
 * store-scoped and a storeCol is given, ` AND <storeCol> IN (...)`. An owner (null) adds nothing;
 * a company-only grant has storeIds = all stores in the companies, so the store clause is a
 * no-op superset — only explicit per-store grants actually narrow. Returns { sql, params }.
 */
export function scopeWhere(scope, companyCol, storeCol = null) {
  const { companyIds, storeIds } = normalizeScope(scope);
  const c = scopeClause(companyIds, companyCol);
  const s = storeCol ? scopeClause(storeIds, storeCol) : { sql: '', params: [] };
  return { sql: c.sql + s.sql, params: [...c.params, ...s.params] };
}

/** The full company×user grant map for the settings matrix. */
export async function companyGrantMatrix(x = getExecutor()) {
  const rows = await x.many('SELECT user_id, company_id FROM user_companies', []);
  const byUser = new Map();
  for (const r of rows) {
    const uid = Number(r.user_id);
    if (!byUser.has(uid)) byUser.set(uid, new Set());
    byUser.get(uid).add(Number(r.company_id));
  }
  return byUser; // Map<userId, Set<companyId>>
}
