import { Router } from 'express';
import { dashboardStats } from '../services/reports.js';
import { listRecent } from '../services/audit.js';

const router = Router();

router.get('/', (req, res) => {
  res.render('dashboard', { title: 'לוח בקרה', stats: dashboardStats() });
});

router.get('/audit', (req, res) => {
  res.render('audit', { title: 'יומן ביקורת', entries: listRecent(200) });
});

// Stage-1 role switch (not a security boundary — see README / currentUser middleware).
router.post('/switch-user', (req, res) => {
  const uid = Number(req.body.uid);
  if (Number.isInteger(uid)) {
    res.cookie('uid', String(uid), { httpOnly: true, sameSite: 'lax' });
  }
  res.redirect(req.get('referer') || '/');
});

export default router;
