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
