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

router.post('/store', async (req, res, next) => {
  try {
    const raw = (req.body.store_id ?? '').toString().trim();
    const dest = safeReturn(req);
    if (!raw) {
      // Empty selection = clear the context (owner/multi-store → "all stores").
      res.clearCookie('ap_store');
      return res.redirect(dest);
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
    // Silently ignore an unauthorized/invalid store id (no cross-store leak); just redirect back.
    return res.redirect(dest);
  } catch (err) {
    return next(err);
  }
});

export default router;
