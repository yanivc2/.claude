import { AuthError } from '../lib/errors.js';
import { userCan, canViewPage, firstAllowedPath } from '../lib/permissions.js';

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
