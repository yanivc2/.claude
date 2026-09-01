import { Router } from 'express';
import { requireOwner } from '../middleware/requireOwner.js';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '../services/notifications.js';

// In-app notification stream (bell + page). Owner-facing — the same alerts that go to Telegram.
const router = Router();
router.use(requireOwner);

router.get('/', async (req, res, next) => {
  try {
    res.render('notifications/index', { title: 'התראות', notifications: await listNotifications({ limit: 100 }) });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', async (req, res, next) => {
  try {
    await markAllNotificationsRead();
    res.redirect(303, '/notifications');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    await markNotificationRead(req.params.id);
    const back = (req.body.return_to || '').toString();
    res.redirect(303, back.startsWith('/') && !back.startsWith('//') ? back : '/notifications');
  } catch (err) {
    next(err);
  }
});

export default router;
