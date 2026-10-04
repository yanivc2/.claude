import { userCan } from './permissions.js';
import { assertStoreAllowed } from './scopeGuard.js';
import { RuleError } from './errors.js';

// Entry forms are bound to the store that was ACTIVE when they were rendered. The active store lives
// in one cookie per browser, so a form left open in one tab while the store is switched in another
// would otherwise save into the newly active store — the exact cross-branch mistake the active-store
// rule exists to prevent. Every entry form posts `ctx_store` (partials/_formStore.ejs); a mismatch is
// refused here before anything is written, with a page that can switch back and return to the
// still-filled form (history.back keeps what was typed).

/** null when the form matches the active store (or carries no ctx_store), else the two ids. */
export function staleStoreFor(req) {
  const b = req.body || {};
  if (b.ctx_store === undefined) return null;
  const formStoreId = Number(b.ctx_store) || 0;
  const activeStoreId = Number(req.activeStoreId) || 0;
  return formStoreId === activeStoreId ? null : { formStoreId, activeStoreId };
}

export function renderStaleStore(req, res, stale) {
  const stores = res.locals.availableStores || [];
  const nameOf = (id) => {
    const s = stores.find((x) => Number(x.id) === Number(id));
    return s ? `${s.name} · ${s.company_name}` : null;
  };
  return res.status(409).render('stale-store', {
    title: 'החנות הפעילה הוחלפה',
    formStore: stale.formStoreId ? { id: stale.formStoreId, name: nameOf(stale.formStoreId) } : null,
    activeName: stale.activeStoreId ? nameOf(stale.activeStoreId) : 'כל החנויות',
  });
}

/** App-level guard for urlencoded forms. Multipart routes call staleStoreFor themselves after multer. */
export function staleStoreGuard(req, res, next) {
  if (req.method !== 'POST') return next();
  const stale = staleStoreFor(req);
  return stale ? renderStaleStore(req, res, stale) : next();
}

/**
 * An edit form may MOVE a record to another store only for a user with view_all_stores (owner
 * always). The target is checked against the caller's UNNARROWED grants — req.scope is narrowed to
 * the active store, which by definition is not the target. Returns true when this is a move.
 */
export async function assertStoreMove(req, fromStoreId, toStoreId) {
  if (!toStoreId || Number(toStoreId) === Number(fromStoreId)) return false;
  if (!userCan(req.user, 'view_all_stores')) {
    throw new RuleError('VALIDATION', 'העברה לחנות אחרת מותרת רק למי שיש לו הרשאת "צפייה בכל החנויות".');
  }
  await assertStoreAllowed(toStoreId, req.grantedScope || req.scope);
  return true;
}
