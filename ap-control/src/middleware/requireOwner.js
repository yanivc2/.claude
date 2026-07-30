import { AuthError } from '../lib/errors.js';

// Route-level guard for owner-only actions (defense in depth alongside the service checks).
// Structural/config changes and destructive actions (settings, voiding a check) are owner-only.
export function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') {
    return next(new AuthError('פעולה זו מותרת לבעלים בלבד'));
  }
  next();
}
