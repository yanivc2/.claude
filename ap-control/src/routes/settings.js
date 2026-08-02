import { Router } from 'express';
import {
  listStructure,
  createCompany,
  updateCompany,
  createStoreWithAccount,
  updateAccountDisplayName,
} from '../services/orgs.js';
import {
  listUsers,
  createUser,
  updateUser,
  resetPasswordByOwner,
  changeOwnPassword,
  deleteUser,
} from '../services/users.js';
import { upgradeSchema } from '../db/index.js';
import { requireOwner, requirePermission } from '../middleware/requireOwner.js';
import { PERMISSIONS } from '../lib/permissions.js';
import { config } from '../config.js';
import { sendTelegram } from '../lib/notify.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

// Settings requires the "settings" permission (owner always passes). User-management and
// DB-upgrade actions are additionally owner-only — enforced per-route below and in services.
router.use(requirePermission('settings'));

async function render(req, res, extra = {}) {
  // Be resilient if the live DB predates a new column (e.g. users.email): still render the page
  // so the owner can click "עדכן מסד נתונים" below. schemaWarning surfaces the need.
  let companies = [];
  let users = [];
  let schemaWarning = null;
  try {
    companies = await listStructure();
  } catch (e) {
    schemaWarning = 'ייתכן שנדרש עדכון מסד נתונים — לחץ "עדכן מסד נתונים".';
  }
  try {
    users = await listUsers();
  } catch (e) {
    schemaWarning = 'ייתכן שנדרש עדכון מסד נתונים — לחץ "עדכן מסד נתונים".';
  }
  res.render('settings/index', {
    title: 'הגדרות',
    companies,
    users,
    permissionCatalog: PERMISSIONS,
    telegram: { enabled: config.telegram.enabled, chatId: config.telegram.chatId },
    error: null,
    notice: null,
    schemaWarning,
    ...extra,
  });
}

// Send a test push so the owner can confirm the Telegram channel is wired (the bot token stays
// env-only, §12 — this only verifies it, never sets it).
router.post('/test-push', requireOwner, async (req, res, next) => {
  try {
    if (!config.telegram.enabled) {
      return render(req, res, { error: 'פוש אינו מוגדר — יש להגדיר TELEGRAM_BOT_TOKEN בסביבה ולפרוס מחדש.' });
    }
    const ok = await sendTelegram('✅ <b>בדיקת פוש — AP Control</b>\nההתראות מחוברות ופועלות.');
    return render(req, res, ok ? { notice: 'נשלחה הודעת בדיקה בטלגרם.' } : { error: 'שליחת הבדיקה נכשלה — בדוק את הטוקן/מזהה הצ׳אט.' });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    await render(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/companies', async (req, res, next) => {
  try {
    await createCompany({ name: req.body.name, companyType: req.body.company_type, taxId: req.body.tax_id }, req.user);
    await render(req, res, { notice: 'חברה נוספה.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/companies/:id', async (req, res, next) => {
  try {
    await updateCompany(Number(req.params.id), { name: req.body.name, taxId: req.body.tax_id }, req.user);
    await render(req, res, { notice: 'פרטי החברה עודכנו.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/stores', async (req, res, next) => {
  try {
    await createStoreWithAccount(
      {
        companyId: Number(req.body.company_id),
        storeName: req.body.store_name,
        address: req.body.address,
        bankName: req.body.bank_name,
        branch: req.body.branch,
        accountNumber: req.body.account_number,
        displayName: req.body.display_name,
      },
      req.user,
    );
    await render(req, res, { notice: 'חנות וחשבון בנק נוספו.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/accounts/:id', async (req, res, next) => {
  try {
    await updateAccountDisplayName(Number(req.params.id), req.body.display_name, req.user);
    await render(req, res, { notice: 'שם התצוגה של החשבון עודכן.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// --- Owner's own password (moved here from the header) ---
router.post('/password', async (req, res, next) => {
  try {
    await changeOwnPassword(req.user.id, { current: req.body.current, next: req.body.next, confirm: req.body.confirm });
    await render(req, res, { notice: 'הסיסמה שלך עודכנה.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// --- User management (owner-only) ---
router.use('/users', requireOwner);

router.post('/users', async (req, res, next) => {
  try {
    await createUser(
      {
        name: req.body.name, username: req.body.username, email: req.body.email,
        role: req.body.role, label: req.body.label, permissions: req.body.permissions,
        password: req.body.password,
      },
      req.user,
    );
    await render(req, res, { notice: 'משתמש נוסף.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/users/:id', async (req, res, next) => {
  try {
    await updateUser(
      Number(req.params.id),
      { name: req.body.name, email: req.body.email, role: req.body.role, label: req.body.label, permissions: req.body.permissions },
      req.user,
    );
    await render(req, res, { notice: 'פרטי המשתמש עודכנו.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    await resetPasswordByOwner(Number(req.params.id), req.body.password, req.user);
    await render(req, res, { notice: 'הסיסמה אופסה.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/users/:id/delete', async (req, res, next) => {
  try {
    await deleteUser(Number(req.params.id), req.user);
    await render(req, res, { notice: 'המשתמש נמחק.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// One-click DB schema upgrade (idempotent) — adds any columns/tables a new deploy needs. Owner-only.
router.post('/db-upgrade', requireOwner, async (req, res, next) => {
  try {
    await upgradeSchema();
    await render(req, res, { notice: 'מסד הנתונים עודכן בהצלחה — כל העמודות והטבלאות החדשות קיימות.' });
  } catch (err) {
    next(err);
  }
});

export default router;
