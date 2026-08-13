import { Router } from 'express';
import { getExecutor } from '../db/adapter.js';
import { verifyPassword, hashPassword, passwordPolicyError, PASSWORD_POLICY_TEXT } from '../lib/auth.js';
import { logAction } from '../services/audit.js';

const router = Router();

router.get('/password', (req, res) => {
  res.render('account/password', {
    title: 'שינוי סיסמה', error: null, notice: null,
    forced: !!req.user.must_change_password, policyText: PASSWORD_POLICY_TEXT,
  });
});

router.post('/password', async (req, res, next) => {
  const forced = !!req.user.must_change_password;
  const fail = (error) => res.status(400).render('account/password', { title: 'שינוי סיסמה', notice: null, error, forced, policyText: PASSWORD_POLICY_TEXT });
  try {
    const current = req.body.current || '';
    const next1 = req.body.next || '';
    const confirm = req.body.confirm || '';
    const x = getExecutor();
    const user = await x.one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(current, user.password_hash)) return fail('הסיסמה הנוכחית שגויה');
    const pwErr = passwordPolicyError(next1);
    if (pwErr) return fail(pwErr);
    if (next1 === current) return fail('הסיסמה החדשה חייבת להיות שונה מהסיסמה הנוכחית');
    if (next1 !== confirm) return fail('אישור הסיסמה אינו תואם');
    // Clears must_change_password so the forced-change gate lets the user through afterwards.
    await x.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(next1), req.user.id]);
    await logAction({ userId: req.user.id, action: 'auth.password_change', entityType: 'user', entityId: req.user.id });
    if (forced) return res.redirect(303, '/?pwchanged=1');
    res.render('account/password', { title: 'שינוי סיסמה', error: null, forced: false, policyText: PASSWORD_POLICY_TEXT, notice: 'הסיסמה עודכנה בהצלחה.' });
  } catch (err) {
    next(err);
  }
});

export default router;
