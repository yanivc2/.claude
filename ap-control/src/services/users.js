import { getExecutor } from '../db/adapter.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
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

/** All users (no password hashes) for the settings screen. */
export async function listUsers(x = getExecutor()) {
  return x.many('SELECT id, name, role, username, email FROM users ORDER BY role, name', []);
}

export async function getUser(id, x = getExecutor()) {
  const u = await x.one('SELECT id, name, role, username, email FROM users WHERE id = ?', [id]);
  if (!u) throw new NotFoundError(`משתמש ${id} לא נמצא`);
  return u;
}

export async function createUser({ name, username, email, role, password }, actor, x = getExecutor()) {
  requireOwner(actor);
  const nm = (name ?? '').trim();
  const un = (username ?? '').trim();
  if (!nm) throw new RuleError('VALIDATION', 'שם חובה');
  if (!un) throw new RuleError('VALIDATION', 'שם משתמש (לוגין) חובה');
  if (!ROLES.includes(role)) throw new RuleError('VALIDATION', 'תפקיד לא תקין');
  const em = validateEmail(email);
  if ((password ?? '').length < 6) throw new RuleError('VALIDATION', 'סיסמה ראשונית — לפחות 6 תווים');

  const dup = await x.one('SELECT id FROM users WHERE username = ?', [un]);
  if (dup) throw new RuleError('VALIDATION', `שם המשתמש "${un}" כבר קיים`);

  const info = await x.run(
    'INSERT INTO users (name, role, username, email, password_hash) VALUES (?, ?, ?, ?, ?)',
    [nm, role, un, em, hashPassword(password)],
  );
  await logAction({ userId: actor.id, action: 'user.create', entityType: 'user', entityId: info.lastInsertRowid, details: { username: un, role } }, x);
  return getUser(info.lastInsertRowid, x);
}

/** Update a user's name / email / role (add or reduce permissions). */
export async function updateUser(id, { name, email, role }, actor, x = getExecutor()) {
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

  await x.run('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?', [nm, em, rl, id]);
  await logAction({ userId: actor.id, action: 'user.update', entityType: 'user', entityId: id, details: { role: rl } }, x);
  return getUser(id, x);
}

/** Owner resets another user's password directly (no email needed). */
export async function resetPasswordByOwner(id, newPassword, actor, x = getExecutor()) {
  requireOwner(actor);
  await getUser(id, x);
  if ((newPassword ?? '').length < 6) throw new RuleError('VALIDATION', 'סיסמה חדשה — לפחות 6 תווים');
  await x.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), id]);
  await logAction({ userId: actor.id, action: 'user.password_reset', entityType: 'user', entityId: id }, x);
}

/** A user changes their own password (verifies the current one first). */
export async function changeOwnPassword(userId, { current, next, confirm }, x = getExecutor()) {
  const user = await x.one('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new NotFoundError('משתמש לא נמצא');
  if (!verifyPassword(current || '', user.password_hash)) throw new RuleError('VALIDATION', 'הסיסמה הנוכחית שגויה');
  if ((next || '').length < 6) throw new RuleError('VALIDATION', 'הסיסמה החדשה חייבת להיות לפחות 6 תווים');
  if (next !== confirm) throw new RuleError('VALIDATION', 'אישור הסיסמה אינו תואם');
  await x.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(next), userId]);
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
