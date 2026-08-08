// Granular permissions. The base role stays owner/secretary, but the owner can grant a
// non-owner ("מזכירה") extra abilities via a checklist — effectively building custom roles
// like "מנהל". An owner implicitly has every permission. User management itself stays
// owner-only (enforced in services/users.js) so permissions can't be used to self-escalate.

export const PERMISSIONS = [
  // Action permissions (grant an ability).
  { key: 'settings', label: 'גישה להגדרות (חנויות / חשבונות)', group: 'פעולות' },
  { key: 'manage_suppliers', label: 'אישור / חסימה / מחיקת ספקים', group: 'פעולות' },
  { key: 'hold_invoice', label: 'החזקה / שחרור חשבונית', group: 'פעולות' },
  { key: 'approve_payment', label: 'אישור תשלום (מנהל חנות)', group: 'פעולות' },
  { key: 'void_payment', label: 'ביטול תשלום / צ׳ק', group: 'פעולות' },
  // Page-access permissions (which screens the role may open). See canViewPage below.
  { key: 'nav_dashboard', label: 'צפייה: לוח בקרה', group: 'עמודים' },
  { key: 'nav_invoices', label: 'צפייה: חשבוניות', group: 'עמודים' },
  { key: 'nav_payments', label: 'צפייה: מרקורים', group: 'עמודים' },
  { key: 'nav_zreports', label: 'צפייה: דוחות Z', group: 'עמודים' },
  { key: 'nav_outstanding', label: 'צפייה: צ׳קים בחוץ', group: 'עמודים' },
  { key: 'nav_reconciliation', label: 'צפייה: התאמת בנק', group: 'עמודים' },
  { key: 'nav_suppliers', label: 'צפייה: ספקים', group: 'עמודים' },
  { key: 'nav_profitability', label: 'צפייה: רווחיות', group: 'עמודים' },
  { key: 'nav_audit', label: 'צפייה: יומן', group: 'עמודים' },
  { key: 'nav_zclosing', label: 'צפייה: סגירת Z', group: 'עמודים' },
];

const VALID = new Set(PERMISSIONS.map((p) => p.key));

// Page-access keys and the route each maps to. The order is the nav order — used to pick a
// landing page for a restricted role.
export const NAV_PAGES = [
  { key: 'nav_dashboard', path: '/' },
  { key: 'nav_invoices', path: '/invoices' },
  { key: 'nav_payments', path: '/payments' },
  { key: 'nav_zreports', path: '/reports/zreports' },
  { key: 'nav_outstanding', path: '/reports/outstanding' },
  { key: 'nav_reconciliation', path: '/reconciliation' },
  { key: 'nav_suppliers', path: '/suppliers' },
  { key: 'nav_profitability', path: '/reports/profitability' },
  { key: 'nav_audit', path: '/audit' },
  { key: 'nav_zclosing', path: '/zclosing' },
];
const NAV_KEYS = new Set(NAV_PAGES.map((p) => p.key));

// Every URL-prefix a given page-permission unlocks. Used by the default-deny firewall
// (enforcePageScope) so a restricted role — e.g. a register-closer with only nav_zclosing —
// can reach ONLY these paths and nothing else (all detail/action/CSV routes included).
export const NAV_ALLOW = {
  nav_dashboard: ['/', '/reports/lookup'],
  nav_invoices: ['/invoices'],
  nav_payments: ['/payments', '/reports/deposits'],
  nav_zreports: ['/reports/zreports', '/reports/deposits', '/reports/zexpenses'],
  nav_outstanding: ['/reports/outstanding'],
  nav_reconciliation: ['/reconciliation'],
  nav_suppliers: ['/suppliers'],
  nav_profitability: ['/reports/profitability'],
  nav_audit: ['/audit'],
  nav_zclosing: ['/zclosing'],
};

// Paths any authenticated user may always reach (own account, logout, legal, cron runner).
export const OPEN_PATHS = ['/account', '/logout', '/privacy', '/accessibility', '/audit/reminders/run'];

/** The set of page-permission keys a user actually has (empty = unrestricted, legacy behavior). */
export function navPermsOf(user) {
  if (!user || user.role === 'owner') return [];
  return parsePermissions(user.permissions).filter((k) => NAV_KEYS.has(k));
}

/**
 * Is a restricted user allowed to reach `path`? Owner and unrestricted users (no nav_* perms)
 * are not the concern of this function — the caller short-circuits them. For a restricted user,
 * access is DEFAULT-DENY: only the prefixes their granted pages unlock (+ OPEN_PATHS, + /settings
 * when they hold the 'settings' action permission) are allowed.
 */
export function pathAllowedForRestricted(user, path) {
  const nav = navPermsOf(user);
  const allow = new Set(OPEN_PATHS);
  for (const k of nav) (NAV_ALLOW[k] || []).forEach((p) => allow.add(p));
  if (userCan(user, 'settings')) allow.add('/settings');
  for (const p of allow) {
    if (p === '/') { if (path === '/') return true; continue; }
    if (path === p || path.startsWith(`${p}/`)) return true;
  }
  return false;
}

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

/**
 * May this user open a given page? Owner sees all. For a non-owner, page access is opt-in but
 * NON-BREAKING: a user who was granted NO page-access permission at all keeps full access (the
 * historical behavior). Once at least one nav_* permission is set, the role is restricted to
 * exactly those pages.
 */
export function canViewPage(user, navKey) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  const nav = parsePermissions(user.permissions).filter((k) => NAV_KEYS.has(k));
  if (nav.length === 0) return true; // no page restrictions configured → sees everything
  return nav.includes(navKey);
}

/** The first page a (possibly restricted) user may open — used as a landing/redirect target. */
export function firstAllowedPath(user) {
  const page = NAV_PAGES.find((p) => canViewPage(user, p.key));
  return page ? page.path : '/account';
}

/** Normalize form input (array / single / undefined) into a validated JSON string, or null. */
export function serializePermissions(input) {
  const arr = [].concat(input || []).filter((k) => VALID.has(k));
  return arr.length ? JSON.stringify(arr) : null;
}
