import { AuthError } from '../lib/errors.js';
import { userCan } from '../lib/permissions.js';

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
