// Authentication primitives: password hashing (scrypt, no external deps) and a stateless
// signed session cookie (HMAC over "userId.expiry"). Both are serverless-friendly — no session
// store needed. The session secret comes from config.auth.sessionSecret.

import crypto from 'node:crypto';
import { config } from '../config.js';

const SCRYPT_KEYLEN = 64;

/** Hash a plaintext password. Returns a self-describing "scrypt$salt$hash" string. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

/** Verify a plaintext password against a stored hash. Constant-time. */
export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const dk = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// Password policy: at least 6 chars, an uppercase letter, a lowercase letter and a digit, and
// LETTERS + DIGITS ONLY (no spaces or special characters).
export const PASSWORD_POLICY_TEXT = 'הסיסמה חייבת לפחות 6 תווים, לכלול אות גדולה, אות קטנה וספרה — אותיות וספרות בלבד';
export function passwordPolicyError(pw) {
  const p = String(pw ?? '');
  if (p.length < 6) return PASSWORD_POLICY_TEXT;
  if (!/[A-Z]/.test(p)) return PASSWORD_POLICY_TEXT;
  if (!/[a-z]/.test(p)) return PASSWORD_POLICY_TEXT;
  if (!/[0-9]/.test(p)) return PASSWORD_POLICY_TEXT;
  if (!/^[A-Za-z0-9]+$/.test(p)) return PASSWORD_POLICY_TEXT; // letters + digits only
  return null;
}

/**
 * Generate a policy-compliant temporary password that's easy to read/type (no ambiguous
 * characters like 0/O, 1/l/I). Always contains an uppercase, a lowercase and a digit.
 */
export function generatePassword(len = 10) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const all = upper + lower + digit;
  const n = Math.max(8, len);
  const bytes = crypto.randomBytes(n);
  const pick = (set, i) => set[bytes[i] % set.length];
  let out = pick(upper, 0) + pick(lower, 1) + pick(digit, 2);
  for (let i = 3; i < n; i += 1) out += all[bytes[i] % all.length];
  return out;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Create a signed session token for a user id, valid for the configured TTL. */
export function createSession(userId, nowMs = Date.now()) {
  const exp = nowMs + config.auth.sessionTtlHours * 3600 * 1000;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload, config.auth.sessionSecret)}`;
}

/** Verify a session token; returns the user id if valid and unexpired, else null. */
export function readSession(token, nowMs = Date.now()) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const payload = `${uid}.${exp}`;
  const expected = sign(payload, config.auth.sessionSecret);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (!Number.isFinite(Number(exp)) || Number(exp) < nowMs) return null;
  return Number(uid);
}
