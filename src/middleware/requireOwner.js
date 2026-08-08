import { AuthError } from '../lib/errors.js';
import { userCan, canViewPage, firstAllowedPath, navPermsOf, pathAllowedForRestricted } from '../lib/permissions.js';

// Route-level guard for owner-only actions (defense in depth alongside the service checks).
export function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') {
    return next(new AuthError('פעולה זו מותרת לבעלים בלבד'));
  }
  next();
}

// Route-level guard for a granted permission (owner always passes).
export function requirePermission(perm) {
  return (req, res, next) => {
    if (!userCan(req.user, perm)) return next(new AuthError('אין לך הרשאה לפעולה זו'));
    next();
  };
}

// Global default-deny firewall for RESTRICTED roles (a user with at least one nav_* permission).
// Such a user may reach ONLY the URL prefixes their granted pages unlock (see NAV_ALLOW). Every
// other path — detail views, CSV exports, settings, approvals, etc. — is refused and the user is
// bounced to their landing page. Owner and unrestricted (legacy, no nav_*) users pass straight
// through, so existing behavior is untouched. This is the primary lock behind a role like the
// "register-closer" (nav_zclosing only), independent of any per-route guard.
export function enforcePageScope(req, res, next) {
  const user = req.user;
  if (!user || user.role === 'owner') return next();
  if (navPermsOf(user).length === 0) return next(); // unrestricted → internal guards apply
  const path = req.path;
  if (pathAllowedForRestricted(user, path)) return next();
  const dest = firstAllowedPath(user);
  if (dest && dest !== path) return res.redirect(dest);
  return next(new AuthError('אין לך גישה לעמוד זה'));
}

// Page-access guard. A restricted role that can't open this page is redirected to the first
// page it CAN open (so it never lands on a dead end). Owner and unrestricted users pass through.
export function requirePageAccess(navKey) {
  return (req, res, next) => {
    if (canViewPage(req.user, navKey)) return next();
    const dest = firstAllowedPath(req.user);
    if (dest && dest !== req.originalUrl.split('?')[0]) return res.redirect(dest);
    return next(new AuthError('אין לך גישה לעמוד זה'));
  };
}
