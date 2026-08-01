import { Router } from 'express';
import { getExecutor } from '../db/adapter.js';
import { verifyPassword, createSession } from '../lib/auth.js';
import { logAction } from '../services/audit.js';

const router = Router();

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'התחברות', error: null });
});

router.post('/login', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const user = await getExecutor().one('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).render('login', { title: 'התחברות', error: 'שם משתמש או סיסמה שגויים' });
    }
    res.cookie('session', createSession(user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps(req),
      maxAge: 12 * 3600 * 1000,
    });
    await logAction({ userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect('/login');
});

export default router;
