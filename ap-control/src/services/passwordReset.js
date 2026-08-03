import crypto from 'node:crypto';
import { getExecutor } from '../db/adapter.js';
import { hashPassword, passwordPolicyError } from '../lib/auth.js';
import { sendMail, mailEnabled } from '../lib/mailer.js';
import { config } from '../config.js';
import { logAction } from './audit.js';

// Email-based password reset. A random token is emailed to the user; only its SHA-256 hash is
// stored. Tokens are single-use and expire after RESET_TTL_MIN minutes. To avoid leaking which
// accounts exist, the route always shows the same neutral message — this service just reports
// back to the caller what actually happened (for logging / owner diagnostics), never to the UI.

const RESET_TTL_MIN = 60;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function resetLink(origin, token) {
  const base = (config.mail.appUrl || origin || '').replace(/\/$/, '');
  return `${base}/reset/${token}`;
}

/**
 * Start a reset for the given identifier (username or email). Neutral by design.
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function requestReset(identifier, { origin } = {}, x = getExecutor()) {
  const id = (identifier || '').trim();
  if (!id) return { sent: false, reason: 'empty' };

  const user = await x.one(
    'SELECT id, name, email FROM users WHERE username = ? OR LOWER(email) = LOWER(?)',
    [id, id],
  );
  if (!user) return { sent: false, reason: 'no_user' };
  if (!user.email) return { sent: false, reason: 'no_email' };
  if (!mailEnabled()) return { sent: false, reason: 'not_configured' };

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000).toISOString();
  await x.run(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [user.id, sha256(token), expires],
  );

  const link = resetLink(origin, token);
  const html = `
    <div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;color:#1c2430">
      <h2>איפוס סיסמה — AP Control</h2>
      <p>שלום ${user.name || ''},</p>
      <p>התקבלה בקשה לאיפוס הסיסמה שלך. לחץ על הקישור הבא כדי לבחור סיסמה חדשה (תקף לשעה):</p>
      <p><a href="${link}" style="background:#1f6feb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">איפוס סיסמה</a></p>
      <p style="color:#6b7684">אם לא ביקשת זאת, אפשר להתעלם מהמייל — הסיסמה לא תשתנה.</p>
    </div>`;
  const res = await sendMail({ to: user.email, subject: 'איפוס סיסמה — AP Control', html });
  await logAction({ userId: user.id, action: 'auth.password_reset_request', entityType: 'user', entityId: user.id, details: { sent: res.sent } }, x);
  return res;
}

/**
 * Create a set-password link for a user WITHOUT sending email — used by the owner to invite a
 * team member via WhatsApp. Invite tokens live longer (7 days) than email-reset tokens.
 * @returns {Promise<{user:object, link:string}|null>}
 */
export async function createInviteLink(userId, { origin } = {}, x = getExecutor()) {
  const user = await x.one('SELECT id, name, username, phone FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await x.run(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [user.id, sha256(token), expires],
  );
  await logAction({ userId: user.id, action: 'auth.invite_link', entityType: 'user', entityId: user.id }, x);
  return { user, link: resetLink(origin, token) };
}

/** Return the valid (unexpired, unused) reset row + user for a raw token, or null. */
export async function verifyResetToken(token, x = getExecutor()) {
  if (!token) return null;
  const row = await x.one('SELECT * FROM password_resets WHERE token_hash = ?', [sha256(token)]);
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const user = await x.one('SELECT id, name, username FROM users WHERE id = ?', [row.user_id]);
  return user ? { reset: row, user } : null;
}

/** Complete a reset: set the new password and burn the token. */
export async function completeReset(token, newPassword, x = getExecutor()) {
  const found = await verifyResetToken(token, x);
  if (!found) return { ok: false, reason: 'invalid' };
  if (passwordPolicyError(newPassword)) return { ok: false, reason: 'policy' };
  await x.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), found.user.id]);
  await x.run('UPDATE password_resets SET used_at = ? WHERE id = ?', [new Date().toISOString(), found.reset.id]);
  await logAction({ userId: found.user.id, action: 'auth.password_reset_complete', entityType: 'user', entityId: found.user.id }, x);
  return { ok: true };
}
