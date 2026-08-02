import { Router } from 'express';
import { legalLocals } from '../lib/legal.js';

// Public legal / compliance pages: privacy notice + accessibility statement.
// These must be reachable without a login (data subjects, auditors), so their paths are also
// whitelisted in the currentUser auth gate.

const router = Router();

router.get('/privacy', (req, res) => {
  res.render('legal/privacy', { title: 'הודעת פרטיות', ...legalLocals });
});

router.get('/accessibility', (req, res) => {
  res.render('legal/accessibility', { title: 'הצהרת נגישות', ...legalLocals });
});

export default router;
