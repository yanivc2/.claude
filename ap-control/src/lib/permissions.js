// Granular permissions. The base role stays owner/secretary, but the owner can grant a
// non-owner ("מזכירה") extra abilities via a checklist — effectively building custom roles
// like "מנהל". An owner implicitly has every permission. User management itself stays
// owner-only (enforced in services/users.js) so permissions can't be used to self-escalate.

export const PERMISSIONS = [
  { key: 'settings', label: 'גישה להגדרות (חנויות / חשבונות)' },
  { key: 'manage_suppliers', label: 'אישור / חסימה / מחיקת ספקים' },
  { key: 'hold_invoice', label: 'החזקה / שחרור חשבונית' },
  { key: 'void_payment', label: 'ביטול תשלום / צ׳ק' },
];

const VALID = new Set(PERMISSIONS.map((p) => p.key));

/** Parse a permissions value (JSON string from the DB, or an array) into a clean key array. */
export function parsePermissions(value) {
  let arr = value;
  if (typeof value === 'string') {
    try { arr = JSON.parse(value); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((k) => VALID.has(k));
}

/** Owner has everything; otherwise the ability must be in the user's granted permissions. */
export function userCan(user, perm) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return parsePermissions(user.permissions).includes(perm);
}

/** Normalize form input (array / single / undefined) into a validated JSON string, or null. */
export function serializePermissions(input) {
  const arr = [].concat(input || []).filter((k) => VALID.has(k));
  return arr.length ? JSON.stringify(arr) : null;
}
