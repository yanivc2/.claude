import { getExecutor } from '../db/adapter.js';

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

export async function currentUser(req, res, next) {
  try {
    const x = getExecutor();
    const cookies = parseCookies(req.headers.cookie);
    let user;
    if (cookies.uid) {
      user = await x.one('SELECT * FROM users WHERE id = ?', [Number(cookies.uid)]);
    }
    if (!user) {
      // Default to a secretary (the primary day-to-day operator).
      user =
        (await x.one("SELECT * FROM users WHERE role = 'secretary' ORDER BY id LIMIT 1", [])) ||
        (await x.one('SELECT * FROM users ORDER BY id LIMIT 1', []));
    }
    req.user = user;
    res.locals.currentUser = user;
    res.locals.allUsers = await x.many('SELECT * FROM users ORDER BY role DESC, id', []);
    next();
  } catch (err) {
    next(err);
  }
}
