import { Router } from 'express';
import { getExecutor } from '../db/adapter.js';
import { verifyPassword, hashPassword } from '../lib/auth.js';
import { logAction } from '../services/audit.js';

const router = Router();

router.get('/password', (req, res) => {
  res.render('account/password', { title: 'שינוי סיסמה', error: null, notice: null });
});

router.post('/password', async (req, res, next) => {
  const render = (extra) => res.render('account/password', { title: 'שינוי סיסמה', error: null, notice: null, ...extra });
  try {
    const current = req.body.current || '';
    const next1 = req.body.next || '';
    const confirm = req.body.confirm || '';
    const x = getExecutor();
    const user = await x.one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(current, user.password_hash)) {
      return res.status(400).render('account/password', { title: 'שינוי סיסמה', notice: null, error: 'הסיסמה הנוכחית שגויה' });
    }
    if (next1.length < 6) {
      return res.status(400).render('account/password', { title: 'שינוי סיסמה', notice: null, error: 'הסיסמה החדשה חייבת להיות לפחות 6 תווים' });
    }
    if (next1 !== confirm) {
      return res.status(400).render('account/password', { title: 'שינוי סיסמה', notice: null, error: 'אישור הסיסמה אינו תואם' });
    }
    await x.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(next1), req.user.id]);
    await logAction({ userId: req.user.id, action: 'auth.password_change', entityType: 'user', entityId: req.user.id });
    render({ notice: 'הסיסמה עודכנה בהצלחה.' });
  } catch (err) {
    next(err);
  }
});

export default router;
