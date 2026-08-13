import { Router } from 'express';
import { getExecutor } from '../db/adapter.js';
import { verifyPassword, createSession, PASSWORD_POLICY_TEXT } from '../lib/auth.js';
import { requestReset, verifyResetToken, completeReset } from '../services/passwordReset.js';
import { mailEnabled } from '../lib/mailer.js';
import { logAction } from '../services/audit.js';
import { firstAllowedPath } from '../lib/permissions.js';
import { loginAllowedNow, israelClock } from '../lib/loginHours.js';
import { notify } from '../lib/notify.js';

const router = Router();

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function origin(req) {
  return `${isHttps(req) ? 'https' : req.protocol}://${req.get('host')}`;
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(303, '/');
  const error = req.query.blocked === 'hours'
    ? 'ההתחברות חסומה כעת מחוץ לשעות המותרות (שעון ישראל).'
    : null;
  res.render('login', { title: 'התחברות', error });
});

router.post('/login', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const user = await getExecutor().one('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).render('login', { title: 'התחברות', error: 'שם משתמש או סיסמה שגויים' });
    }
    // Per-user login hours (Israel time): reject outside the allowed window.
    const gate = loginAllowedNow(user);
    if (!gate.allowed) {
      await logAction({ userId: user.id, action: 'auth.login_blocked', entityType: 'user', entityId: user.id, details: { window: gate.window, at: gate.hhmm } });
      return res.status(403).render('login', {
        title: 'התחברות',
        error: `ההתחברות מותרת רק בין ${gate.window} (שעון ישראל). השעה כעת: ${gate.hhmm}.`,
      });
    }
    res.cookie('session', createSession(user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps(req),
      maxAge: 12 * 3600 * 1000,
    });
    await logAction({ userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
    // Push (Telegram): notify the owner on every login.
    try {
      const roleLabel = user.role === 'owner' ? 'בעלים' : (user.label || 'משתמש');
      notify(`🔓 <b>התחברות למערכת</b>\n${user.name || user.username} (${roleLabel})\nשעה: ${israelClock().hhmm} (שעון ישראל)`);
    } catch { /* best-effort */ }
    // Land on the first page this (possibly restricted) user may open — e.g. a register-closer
    // goes straight to /zclosing instead of bouncing off the dashboard guard.
    res.redirect(303, firstAllowedPath(user));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect(303, '/login');
});

// --- "שכחתי סיסמה" (email reset) ---
router.get('/forgot', (req, res) => {
  if (req.user) return res.redirect(303, '/');
  res.render('forgot', { title: 'שכחתי סיסמה', notice: null, error: null, mailEnabled: mailEnabled() });
});

router.post('/forgot', async (req, res, next) => {
  try {
    await requestReset(req.body.identifier, { origin: origin(req) });
    // Neutral response regardless of whether a matching user/email exists.
    res.render('forgot', {
      title: 'שכחתי סיסמה',
      notice: 'אם קיים חשבון תואם עם כתובת מייל, נשלח אליו קישור לאיפוס סיסמה.',
      error: null,
      mailEnabled: mailEnabled(),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/reset/:token', async (req, res, next) => {
  try {
    const found = await verifyResetToken(req.params.token);
    if (!found) return res.status(400).render('reset', { title: 'איפוס סיסמה', token: null, error: 'הקישור אינו תקף או שפג תוקפו.' });
    res.render('reset', { title: 'איפוס סיסמה', token: req.params.token, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/reset/:token', async (req, res, next) => {
  try {
    const next1 = req.body.next || '';
    if (next1 !== (req.body.confirm || '')) {
      return res.status(400).render('reset', { title: 'איפוס סיסמה', token: req.params.token, error: 'אישור הסיסמה אינו תואם.' });
    }
    const result = await completeReset(req.params.token, next1);
    if (!result.ok) {
      const msg = result.reason === 'policy' ? PASSWORD_POLICY_TEXT : 'הקישור אינו תקף או שפג תוקפו.';
      return res.status(400).render('reset', { title: 'איפוס סיסמה', token: result.reason === 'policy' ? req.params.token : null, error: msg });
    }
    res.render('login', { title: 'התחברות', error: null, notice: 'הסיסמה עודכנה — אפשר להתחבר עם הסיסמה החדשה.' });
  } catch (err) {
    next(err);
  }
});

export default router;
