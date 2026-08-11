// Granular permissions. The base role stays owner/secretary, but the owner can grant a
// non-owner ("מזכירה") extra abilities via a checklist — effectively building custom roles
// like "מנהל". An owner implicitly has every permission. User management itself stays
// owner-only (enforced in services/users.js) so permissions can't be used to self-escalate.

export const PERMISSIONS = [
  // Action permissions (grant an ability). `desc` explains what the toggle does, `icon` is a
  // small visual cue for the permission picker.
  { key: 'settings', label: 'גישה להגדרות', group: 'פעולות', icon: '⚙️', desc: 'כניסה לדף ההגדרות — חברות, חנויות ומשתמשים.' },
  { key: 'manage_suppliers', label: 'ניהול ספקים', group: 'פעולות', icon: '🏢', desc: 'אישור, חסימה ומחיקה של ספקים.' },
  { key: 'hold_invoice', label: 'החזקת חשבונית', group: 'פעולות', icon: '⏸️', desc: 'החזקה ושחרור של חשבוניות.' },
  { key: 'approve_payment', label: 'אישור תשלום', group: 'פעולות', icon: '✅', desc: 'אישור חשבונית לתשלום וביצוע תשלום (מנהל חנות).' },
  { key: 'void_payment', label: 'ביטול תשלום', group: 'פעולות', icon: '🚫', desc: 'ביטול צ׳ק או תשלום.' },
  { key: 'edit_invoice', label: 'עריכת חשבונית', group: 'פעולות', icon: '✏️', desc: 'עריכת פרטי חשבונית קיימת.' },
  { key: 'delete_zreport', label: 'מחיקת דוח Z', group: 'פעולות', icon: '🗑️', desc: 'מחיקת דוחות Z.' },
  { key: 'manage_deposits', label: 'ניהול הפקדות', group: 'פעולות', icon: '🏷️', desc: 'סימון הפקדה כ"הופקד" ומחיקת הצהרות הפקדה.' },
  { key: 'import_bank', label: 'ייבוא בנק', group: 'פעולות', icon: '🏦', desc: 'ייבוא תנועות בנק (קובץ/ידני) בהתאמת בנק.' },
  // Page-access permissions (which screens the role may open). See canViewPage below.
  { key: 'nav_dashboard', label: 'לוח בקרה', group: 'עמודים', icon: '🏠', desc: 'מסך הבית עם קיצורים וקוביות מצב.' },
  { key: 'nav_invoices', label: 'חשבוניות', group: 'עמודים', icon: '🧾', desc: 'רשימת החשבוניות והזנתן.' },
  { key: 'nav_payments', label: 'מרקורים', group: 'עמודים', icon: '💳', desc: 'תשלומים והצהרות הפקדה.' },
  { key: 'nav_zreports', label: 'דוחות Z', group: 'עמודים', icon: '📊', desc: 'הזנה ועריכה של דוחות Z.' },
  { key: 'nav_outstanding', label: 'צ׳קים בחוץ', group: 'עמודים', icon: '📤', desc: 'צ׳קים שטרם נפרעו.' },
  { key: 'nav_reconciliation', label: 'התאמת בנק', group: 'עמודים', icon: '🏦', desc: 'ייבוא והתאמת תנועות בנק.' },
  { key: 'nav_suppliers', label: 'ספקים', group: 'עמודים', icon: '🏢', desc: 'רשימת הספקים ואנשי הקשר.' },
  { key: 'nav_profitability', label: 'רווחיות', group: 'עמודים', icon: '💰', desc: 'דוח רווח גולמי ומרווח.' },
  { key: 'nav_audit', label: 'יומן', group: 'עמודים', icon: '📅', desc: 'לוח שנה, תזכורות ולוג פעולות.' },
  { key: 'nav_employees', label: 'עובדים ומשכורות', group: 'עמודים', icon: '👥', desc: 'עובדים ומעקב מפרעות/שכר מדוחות Z.' },
  { key: 'nav_zclosing', label: 'סגירת Z', group: 'עמודים', icon: '🔒', desc: 'ספירת קופה. לעובד קופה — סמן רק את זה כדי לנעול אותו לדף זה בלבד.' },
  { key: 'nav_scan', label: 'צילום חשבוניות', group: 'עמודים', icon: '📷', desc: 'צילום חשבוניות בנייד, עיבוד אוטומטי ואישור קליטה.' },
  { key: 'nav_products', label: 'מוצרים', group: 'עמודים', icon: '🏷️', desc: 'קטלוג מוצרים ומחירי קנייה לפי ספק.' },
];

const VALID = new Set(PERMISSIONS.map((p) => p.key));

// One-click role presets for the permission picker — a starting point the owner can then tweak.
// Each ticks a sensible set of the real permissions above (owner is a separate base role).
export const ROLE_PRESETS = [
  {
    key: 'secretary', label: 'מזכירה', icon: '🧑‍💼',
    desc: 'הזנת חשבוניות, מרקורים ודוחות Z.',
    perms: ['nav_dashboard', 'nav_invoices', 'nav_payments', 'nav_zreports', 'nav_suppliers', 'nav_scan', 'hold_invoice'],
  },
  {
    key: 'store_manager', label: 'מנהל חנות', icon: '👔',
    desc: 'כמו מזכירה + אישור תשלומים, ניהול ספקים ורווחיות.',
    perms: ['nav_dashboard', 'nav_invoices', 'nav_payments', 'nav_zreports', 'nav_suppliers', 'nav_outstanding', 'nav_profitability', 'nav_reconciliation', 'nav_scan', 'nav_products', 'nav_employees', 'hold_invoice', 'approve_payment', 'manage_suppliers', 'edit_invoice', 'manage_deposits', 'import_bank'],
  },
  {
    key: 'cashier', label: 'עובד קופה', icon: '🔒',
    desc: 'גישה אך ורק לדף "סגירת Z".',
    perms: ['nav_zclosing'],
  },
  {
    key: 'invoice_scanner', label: 'צלם חשבוניות', icon: '📷',
    desc: 'גישה אך ורק לצילום וקליטת חשבוניות.',
    perms: ['nav_scan'],
  },
  {
    key: 'viewer', label: 'צפייה בלבד', icon: '👁️',
    desc: 'רואה את כל הדפים, ללא הרשאות פעולה.',
    perms: ['nav_dashboard', 'nav_invoices', 'nav_payments', 'nav_zreports', 'nav_outstanding', 'nav_reconciliation', 'nav_suppliers', 'nav_profitability', 'nav_audit', 'nav_employees'],
  },
];

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
  { key: 'nav_employees', path: '/employees' },
  { key: 'nav_zclosing', path: '/zclosing' },
  { key: 'nav_scan', path: '/scan' },
  { key: 'nav_products', path: '/products' },
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
  nav_employees: ['/employees'],
  nav_zclosing: ['/zclosing'],
  nav_scan: ['/scan'],
  nav_products: ['/products'],
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
