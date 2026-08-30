import { getExecutor } from '../db/adapter.js';
import { readSession } from '../lib/auth.js';
import { userCan, canViewPage } from '../lib/permissions.js';
import { authorizedCompanyIds, authorizedStoreIds, availableStoresFor } from '../lib/scope.js';
import { loginAllowedNow } from '../lib/loginHours.js';
import { countPending } from '../services/changeRequests.js';
import { countPendingSuppliers } from '../services/suppliers.js';

// Authentication gate. Reads the signed `session` cookie, loads the acting user, and blocks
// unauthenticated access to everything except the login page. Static assets are served earlier
// in the chain (app.js) so they remain public (the login page needs its stylesheet).

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export async function currentUser(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const uid = readSession(cookies.session);
    const user = uid ? await getExecutor().one('SELECT * FROM users WHERE id = ?', [uid]) : null;

    if (!user) {
      // Public auth pages + the cron-triggered reminders runner (guarded by its own key).
      if (
        req.path === '/login' ||
        req.path === '/forgot' ||
        req.path.startsWith('/reset/') ||
        req.path.startsWith('/invite/') ||
        req.path === '/privacy' ||
        req.path === '/accessibility' ||
        req.path === '/audit/reminders/run'
      ) return next();
      return res.redirect('/login');
    }

    // Login-hours gate (Israel time): a user outside their allowed window is treated as logged
    // out — their session is cleared and they're bounced to the login page.
    if (!loginAllowedNow(user).allowed) {
      res.clearCookie('session');
      const pub =
        req.path === '/login' || req.path === '/forgot' || req.path.startsWith('/reset/') ||
        req.path.startsWith('/invite/') || req.path === '/privacy' || req.path === '/accessibility';
      if (pub) return next();
      return res.redirect('/login?blocked=hours');
    }

    req.user = user;
    res.locals.currentUser = user;
    res.locals.can = (perm) => userCan(user, perm);
    res.locals.canView = (navKey) => canViewPage(user, navKey);
    res.locals.pendingApprovals = user.role === 'owner' ? (await countPending()) + (await countPendingSuppliers()) : 0;

    // Forced first-login password change: when the owner issued a temporary password
    // (must_change_password=1), block every page except the change-password form + logout
    // until the user picks a new password.
    if (user.must_change_password) {
      const p = req.path;
      const allow = p === '/account/password' || p === '/logout' || p === '/privacy' || p === '/accessibility';
      if (!allow) return res.redirect('/account/password');
    }

    // Per-user company scope (הפרדת חברות): null = all (owner), else the granted company ids.
    // (scope.js degrades gracefully if the user_stores table isn't there yet — pre DB-upgrade.)
    const companyIds = await authorizedCompanyIds(user);
    const storeIds = await authorizedStoreIds(user); // null = all (owner), else granted store ids
    req.scope = { companyIds, storeIds, all: companyIds == null };
    if (companyIds == null) {
      res.locals.scopeCompanies = null; // owner — sees everything
    } else {
      res.locals.scopeCompanies = companyIds.length
        ? await getExecutor().many(
            `SELECT id, name FROM companies WHERE id IN (${companyIds.map(() => '?').join(',')}) ORDER BY name`,
            companyIds,
          )
        : [];
    }

    // Active-store context (בורר "חנות פעילה"). A persistent cookie remembers the chosen store; the
    // header banner shows it and every scoped page/new-form defaults to it. Guards:
    //   • the chosen store must be one the user may access (else it's ignored — no cross-store leak);
    //   • a user with exactly one available store is auto-locked to it (no picker needed);
    //   • owner/multi-store with no valid cookie → null = "all stores".
    const availableStores = await availableStoresFor(user);
    res.locals.availableStores = availableStores;
    let activeStore = null;
    if (availableStores.length === 1) {
      activeStore = availableStores[0];
    } else if (cookies.ap_store) {
      const wanted = Number(cookies.ap_store);
      activeStore = availableStores.find((s) => Number(s.id) === wanted) || null;
    }
    req.activeStoreId = activeStore ? Number(activeStore.id) : null;
    res.locals.activeStore = activeStore; // {id,name,company_id,company_name} or null = all
    return next();
  } catch (err) {
    return next(err);
  }
}
