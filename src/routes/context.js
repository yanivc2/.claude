import { Router } from 'express';
import { availableStoresFor } from '../lib/scope.js';

// Active-store context switch. A single endpoint the header banner posts to. The chosen store is
// validated against the user's authorized stores (never trust the client), then remembered in a
// cookie so the context survives navigation and re-login until the user changes it.
const router = Router();

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// Only same-site relative redirects — never bounce to an absolute/external URL from user input.
function safeReturn(req) {
  const r = (req.body.return_to || '').toString();
  return r.startsWith('/') && !r.startsWith('//') ? r : '/';
}

// The banner posts this via fetch() from an installed iOS PWA (see footer.ejs#apAutoSubmit): a 302
// answer to a POST breaks the PWA out to a Safari sheet, so when the request is the fetch one we
// answer 204 (no body, no redirect) and let the client navigate itself. A plain (no-JS) form post
// still gets the normal redirect.
function isFetch(req) {
  return (req.headers['x-requested-with'] || '').toLowerCase() === 'fetch';
}

router.post('/store', async (req, res, next) => {
  try {
    const raw = (req.body.store_id ?? '').toString().trim();
    const dest = safeReturn(req);
    const done = () => (isFetch(req) ? res.status(204).end() : res.redirect(dest));
    if (!raw) {
      // Empty selection = clear the context (owner/multi-store → "all stores").
      res.clearCookie('ap_store');
      return done();
    }
    const wanted = Number(raw);
    const available = await availableStoresFor(req.user);
    if (Number.isFinite(wanted) && available.some((s) => Number(s.id) === wanted)) {
      res.cookie('ap_store', String(wanted), {
        httpOnly: true,
        sameSite: 'lax',
        secure: isHttps(req),
        maxAge: 365 * 24 * 3600 * 1000,
      });
    }
    // Silently ignore an unauthorized/invalid store id (no cross-store leak); just return/redirect back.
    return done();
  } catch (err) {
    return next(err);
  }
});

export default router;
