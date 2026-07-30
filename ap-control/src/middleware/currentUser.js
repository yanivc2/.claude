import { getDb } from '../db/index.js';

// Stage 1 has no authentication: the app runs on the office PC and the secretary works
// alone, with the owner supervising from the same machine/LAN (§9). We still need to know
// which role is acting so owner-only rules (R6) are enforced and the audit log is meaningful.
// The acting user is kept in a plain `uid` cookie and switched from the header. This is a
// deliberate stage-1 simplification, NOT a security boundary — document in README.

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function currentUser(req, res, next) {
  const db = getDb();
  const cookies = parseCookies(req.headers.cookie);
  let user;
  if (cookies.uid) {
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(cookies.uid));
  }
  if (!user) {
    // Default to a secretary (the primary day-to-day operator).
    user =
      db.prepare("SELECT * FROM users WHERE role = 'secretary' ORDER BY id LIMIT 1").get() ||
      db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
  }
  req.user = user;
  res.locals.currentUser = user;
  res.locals.allUsers = db.prepare('SELECT * FROM users ORDER BY role DESC, id').all();
  next();
}
