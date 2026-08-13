import { getExecutor } from '../db/adapter.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { hashPassword, verifyPassword, passwordPolicyError } from '../lib/auth.js';
import { serializePermissions, parsePermissions } from '../lib/permissions.js';
import { logAction } from './audit.js';

// User & permission management (owner-only). The permission level IS the role:
//   • owner     — full access, including structural config and voiding checks
//   • secretary — day-to-day AP work (no settings, no voids)
// The owner adds/removes a user's permissions by setting their role here.

const ROLES = ['owner', 'secretary'];

function requireOwner(actor) {
  if (!actor || actor.role !== 'owner') throw new AuthError('ניהול משתמשים — בעלים בלבד');
}

function validateEmail(email) {
  const e = (email ?? '').trim();
  if (e === '') return null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new RuleError('VALIDATION', 'כתובת מייל לא תקינה');
  return e.toLowerCase();
}

function shape(u) {
  if (!u) return u;
  return { ...u, permissions: parsePermissions(u.permissions) };
}

/** All users (no password hashes) for the settings screen. */
export async function listUsers(x = getExecutor()) {
  const rows = await x.many('SELECT id, name, role, username, email, label, permissions, login_start, login_end FROM users ORDER BY role, name', []);
  return rows.map(shape);
}

export async function getUser(id, x = getExecutor()) {
  const u = await x.one('SELECT id, name, role, username, email, label, permissions, login_start, login_end FROM users WHERE id = ?', [id]);
  if (!u) throw new NotFoundError(`משתמש ${id} לא נמצא`);
  return shape(u);
}

// Normalize an 'HH:MM' input → a valid 'HH:MM' string or null (empty/invalid).
function normTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

export async function createUser({ name, username, email, role, label, permissions, password, loginStart = null, loginEnd = null }, actor, x = getExecutor()) {
  requireOwner(actor);
  const nm = (name ?? '').trim();
  const un = (username ?? '').trim();
  if (!nm) throw new RuleError('VALIDATION', 'שם חובה');
  if (!un) throw new RuleError('VALIDATION', 'שם משתמש (לוגין) חובה');
  if (!ROLES.includes(role)) throw new RuleError('VALIDATION', 'תפקיד לא תקין');
  const em = validateEmail(email);
  const pwErr = passwordPolicyError(password);
  if (pwErr) throw new RuleError('VALIDATION', pwErr);

  const dup = await x.one('SELECT id FROM users WHERE username = ?', [un]);
  if (dup) throw new RuleError('VALIDATION', `שם המשתמש "${un}" כבר קיים`);

  // Owner already has everything, so per-key permissions only apply to non-owners.
  const perms = role === 'owner' ? null : serializePermissions(permissions);
  const lbl = (label ?? '').trim() || null;

  const info = await x.run(
    'INSERT INTO users (name, role, username, email, label, permissions, password_hash, login_start, login_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [nm, role, un, em, lbl, perms, hashPassword(password), normTime(loginStart), normTime(loginEnd)],
  );
  await logAction({ userId: actor.id, action: 'user.create', entityType: 'user', entityId: info.lastInsertRowid, details: { username: un, role } }, x);
  return getUser(info.lastInsertRowid, x);
}

/** Update a user's name / email / role / label / permissions (add or reduce access). */
export async function updateUser(id, { name, email, role, label, permissions, loginStart, loginEnd }, actor, x = getExecutor()) {
  requireOwner(actor);
  const user = await getUser(id, x);
  const nm = (name ?? '').trim() || user.name;
  const em = email === undefined ? user.email : validateEmail(email);
  const rl = role ?? user.role;
  if (!ROLES.includes(rl)) throw new RuleError('VALIDATION', 'תפקיד לא תקין');

  // Never let the last owner demote themselves out of ownership.
  if (user.role === 'owner' && rl !== 'owner') {
    const owners = await x.one("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'", []);
    if (Number(owners.n) <= 1) throw new RuleError('VALIDATION', 'חייב להישאר לפחות בעלים אחד');
  }

  const perms = rl === 'owner' ? null : serializePermissions(permissions);
  const lbl = (label ?? '').trim() || null;
  // login hours: undefined = leave as-is; otherwise normalize (empty clears the restriction).
  const ls = loginStart === undefined ? user.login_start : normTime(loginStart);
  const le = loginEnd === undefined ? user.login_end : normTime(loginEnd);

  await x.run(
    'UPDATE users SET name = ?, email = ?, role = ?, label = ?, permissions = ?, login_start = ?, login_end = ? WHERE id = ?',
    [nm, em, rl, lbl, perms, ls, le, id],
  );
  await logAction({ userId: actor.id, action: 'user.update', entityType: 'user', entityId: id, details: { role: rl } }, x);
  return getUser(id, x);
}

/** Owner resets another user's password directly (no email needed). */
export async function resetPasswordByOwner(id, newPassword, actor, x = getExecutor()) {
  requireOwner(actor);
  await getUser(id, x);
  const pwErr = passwordPolicyError(newPassword);
  if (pwErr) throw new RuleError('VALIDATION', pwErr);
  // An owner-assigned password is temporary — force the user to change it on next login.
  await x.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(newPassword), id]);
  await logAction({ userId: actor.id, action: 'user.password_reset', entityType: 'user', entityId: id }, x);
}

/** A user changes their own password (verifies the current one first). */
export async function changeOwnPassword(userId, { current, next, confirm }, x = getExecutor()) {
  const user = await x.one('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new NotFoundError('משתמש לא נמצא');
  if (!verifyPassword(current || '', user.password_hash)) throw new RuleError('VALIDATION', 'הסיסמה הנוכחית שגויה');
  const pwErr = passwordPolicyError(next);
  if (pwErr) throw new RuleError('VALIDATION', pwErr);
  if (next !== confirm) throw new RuleError('VALIDATION', 'אישור הסיסמה אינו תואם');
  await x.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(next), userId]);
  await logAction({ userId, action: 'auth.password_change', entityType: 'user', entityId: userId }, x);
}

export async function deleteUser(id, actor, x = getExecutor()) {
  requireOwner(actor);
  const user = await getUser(id, x);
  if (id === actor.id) throw new RuleError('VALIDATION', 'אי אפשר למחוק את המשתמש שלך');
  if (user.role === 'owner') {
    const owners = await x.one("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'", []);
    if (Number(owners.n) <= 1) throw new RuleError('VALIDATION', 'חייב להישאר לפחות בעלים אחד');
  }
  const refs = await x.one('SELECT COUNT(*) AS n FROM payments WHERE created_by = ?', [id]);
  if (Number(refs.n) > 0) throw new RuleError('VALIDATION', 'למשתמש זה יש רשומות מקושרות — לא ניתן למחוק.');
  await x.run('DELETE FROM users WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'user.delete', entityType: 'user', entityId: id }, x);
}

export { ROLES };
