import { getExecutor } from '../db/adapter.js';
import { readSession } from '../lib/auth.js';

// Authentication gate. Reads the signed `session` cookie, loads the acting user, and blocks
// unauthenticated access to everything except the login page. Static assets are served earlier
// in the chain (app.js) so they remain public (the login page needs its stylesheet).

export function parseCookies(header = '') {
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
    const cookies = parseCookies(req.headers.cookie);
    const uid = readSession(cookies.session);
    const user = uid ? await getExecutor().one('SELECT * FROM users WHERE id = ?', [uid]) : null;

    if (!user) {
      // Public auth pages + the cron-triggered reminders runner (guarded by its own key).
      if (
        req.path === '/login' ||
        req.path === '/forgot' ||
        req.path.startsWith('/reset/') ||
        req.path === '/audit/reminders/run'
      ) return next();
      return res.redirect('/login');
    }
    req.user = user;
    res.locals.currentUser = user;
    return next();
  } catch (err) {
    return next(err);
  }
}
