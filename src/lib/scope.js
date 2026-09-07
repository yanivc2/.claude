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
  // ⚠️ `NOT (x NOT IN (…))`, not the obvious `x IN (…)` — do NOT "simplify" this back.
  // The two are identical in SQL (a NULL x is excluded either way, and the list never holds
  // NULLs), and Postgres plans them the same. But pg-mem — the Postgres dialect the test suite
  // runs against — throws "Not supported: lookups on joins" for `… AND <joined table's indexed
  // id> IN (…)`, which is precisely the shape this emits for `st.id` / `ba.store_id` on every
  // scoped store picker and account list. The double-negation defeats its index-lookup path.
  // Reverting this turns TEST_PG=1 red on /audit, /zclosing, /reconciliation and /reports/*.
  return { sql: ` AND NOT (${colExpr} NOT IN (${ph}))`, params: [...companyIds] };
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

/**
 * The stores a request may see, with company name for grouping — the one list every store picker
 * should use. Filters on BOTH dimensions: a user granted one store inside a company must not be
 * offered (or even shown the name of) that company's other stores.
 *
 * This exists because the same unscoped `SELECT … FROM stores JOIN companies` was copy-pasted into
 * several routers, each of which leaked every store in the system into a dropdown.
 * @param {number[]|null|{companyIds,storeIds}} scope
 */
export async function scopedStoreList(scope, x = getExecutor()) {
  const { companyIds, storeIds } = normalizeScope(scope);
  const parts = [];
  const params = [];
  if (companyIds != null) {
    if (!companyIds.length) return [];
    parts.push(`c.id IN (${companyIds.map(() => '?').join(',')})`);
    params.push(...companyIds);
  }
  if (storeIds != null) {
    if (!storeIds.length) return [];
    parts.push(`st.id IN (${storeIds.map(() => '?').join(',')})`);
    params.push(...storeIds);
  }
  const where = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  return x.many(
    `SELECT st.id, st.name, st.company_id, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id${where}
      ORDER BY c.name, st.name`,
    params,
  );
}

/**
 * Filter rows that are scoped through a STORE LINK TABLE (supplier_stores, employee_stores).
 *
 * The rule, shared by suppliers and employees:
 *   • no links at all  → shared with everyone (what every row was before the link existed, and
 *     what a group-wide supplier/employee legitimately is). Never hidden.
 *   • some links       → visible only if at least ONE linked store is inside the caller's scope.
 *
 * A row may be linked to several stores in several companies — that is the point: one supplier
 * delivering to two branches, one employee working at both.
 *
 * Returns the rows that pass, each with `stores` attached ([{id, name, company_id, company_name}])
 * so the screen can show WHICH stores it belongs to.
 *
 * @param {Array<{id:number}>} rows
 * @param {'supplier_stores'|'employee_stores'} table
 * @param {'supplier_id'|'employee_id'} fk
 */
export async function filterByStoreLinks(rows, table, fk, scope, x = getExecutor()) {
  if (!rows || !rows.length) return rows || [];
  const { companyIds, storeIds } = normalizeScope(scope);

  let links = [];
  try {
    links = await x.many(
      `SELECT l.${fk} AS owner_id, st.id AS store_id, st.name AS store_name,
              st.company_id AS company_id, c.name AS company_name
         FROM ${table} l
         JOIN stores st ON st.id = l.store_id
         JOIN companies c ON c.id = st.company_id
        ORDER BY c.name, st.name`,
      [],
    );
  } catch {
    // Pre-upgrade database without the link table: behave as "no links" — nothing is hidden.
    return rows.map((r) => ({ ...r, stores: [] }));
  }

  const byOwner = new Map();
  for (const l of links) {
    const k = Number(l.owner_id);
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push({
      id: Number(l.store_id), name: l.store_name,
      company_id: Number(l.company_id), company_name: l.company_name,
    });
  }

  const out = [];
  for (const r of rows) {
    const stores = byOwner.get(Number(r.id)) || [];
    const visible =
      stores.length === 0 || // unlinked = shared
      (companyIds == null && storeIds == null) || // owner
      stores.some(
        (st) =>
          (companyIds == null || companyIds.includes(st.company_id)) &&
          (storeIds == null || storeIds.includes(st.id)),
      );
    if (visible) out.push({ ...r, stores });
  }
  return out;
}

/**
 * The store a request may look at — the HERMETIC lock behind "חנות פעילה".
 *
 * When an active store is selected it WINS over anything the request asks for: a `?store=`,
 * `?zstore=` or `?account=` pointing elsewhere is ignored, not honoured. Choosing a branch means
 * the whole app is that branch until you switch it; "כל החנויות" is the only way to see across.
 *
 * This is deliberately stronger than "default to the active store": a default still let a stale
 * link, a bookmark or a leftover picker value show another branch's money on a screen whose banner
 * said otherwise — which is exactly how a page ends up showing מידנייט while the banner says גוניור.
 *
 * @param {{activeStoreId?:number|null}} req
 * @param {number|string|null} requested the store the request asked for (query/body), if any
 * @returns {number|null} the store to filter by, or null for "every store I'm allowed to see"
 */
export function effectiveStoreId(req, requested = null) {
  if (req?.activeStoreId) return Number(req.activeStoreId);
  const n = Number(requested);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The ONE documented exception to the active-store lock: the scope to use when a screen is
 * ASSIGNING a row to a branch rather than showing that branch's data.
 *
 * "העתק לחנות" (linking a supplier or an employee to another store) is a management grant — it
 * reveals nothing but a store name the user is already granted, and refusing it while a branch is
 * active would make copying impossible without switching back and forth. Everything else uses the
 * narrowed `req.scope`. Never reach for this to build a LIST, a total, or a detail page.
 */
export function assignmentScope(req) {
  return req?.grantedScope ?? req?.scope ?? null;
}
