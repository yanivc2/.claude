import { getExecutor } from '../db/adapter.js';
import { readSession } from '../lib/auth.js';
import { userCan } from '../lib/permissions.js';
import { authorizedCompanyIds } from '../lib/scope.js';
import { countPending } from '../services/changeRequests.js';

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
        req.path === '/privacy' ||
        req.path === '/accessibility' ||
        req.path === '/audit/reminders/run'
      ) return next();
      return res.redirect('/login');
    }
    req.user = user;
    res.locals.currentUser = user;
    res.locals.can = (perm) => userCan(user, perm);
    res.locals.pendingApprovals = user.role === 'owner' ? await countPending() : 0;

    // Per-user company scope (הפרדת חברות): null = all (owner), else the granted company ids.
    const companyIds = await authorizedCompanyIds(user);
    req.scope = { companyIds, all: companyIds == null };
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
    return next();
  } catch (err) {
    return next(err);
  }
}
