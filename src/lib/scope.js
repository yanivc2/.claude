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
  return getUserCompanyIds(user.id, x);
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
  if (companyIds == null) return { sql: '', params: [] };
  if (companyIds.length === 0) return { sql: ` AND 1 = 0`, params: [] };
  const ph = companyIds.map(() => '?').join(',');
  return { sql: ` AND ${colExpr} IN (${ph})`, params: [...companyIds] };
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
