import { Router } from 'express';
import multer from 'multer';
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
import { getExecutor } from '../db/adapter.js';
import { requireOwner, requirePermission } from '../middleware/requireOwner.js';
import { PERMISSIONS, ROLE_PRESETS } from '../lib/permissions.js';
import { companyGrantMatrix, setUserCompanies } from '../lib/scope.js';
import { createInviteLink } from '../services/passwordReset.js';
import { PASSWORD_POLICY_TEXT, verifyPassword } from '../lib/auth.js';
import { exportAll, resetTransactionalData, restoreAll } from '../services/backup.js';
import { listRoleTemplates, createRoleTemplate, updateRoleTemplate, deleteRoleTemplate } from '../services/roleTemplates.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

function isHttps(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
function origin(req) { return `${isHttps(req) ? 'https' : req.protocol}://${req.get('host')}`; }

// Build the wa.me deep link for an invite. No phone → WhatsApp lets the sender pick a contact.
function whatsappUrl(user, link) {
  const msg =
    `שלום ${user.name || ''}, נפתח עבורך חשבון ב-AP Control.\n` +
    `שם המשתמש שלך: ${user.username}\n` +
    `להגדרת סיסמה: ${link}\n` +
    `${PASSWORD_POLICY_TEXT}.`;
  const phone = (user.phone || '').replace(/[^0-9]/g, '');
  const base = phone ? `https://wa.me/${phone}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(msg)}`;
}

// Settings requires the "settings" permission (owner always passes). User-management and
// DB-upgrade actions are additionally owner-only — enforced per-route below and in services.
router.use(requirePermission('settings'));

async function render(req, res, extra = {}) {
  // Be resilient if the live DB predates a new column (e.g. users.email): still render the page
  // so the owner can click "עדכן מסד נתונים" below. schemaWarning surfaces the need.
  let companies = [];
  let users = [];
  let companyList = [];
  let grants = {}; // { userId: [companyId, ...] } for the company×user matrix
  let roleTemplates = []; // saved permission presets the owner can apply to a user
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
  try {
    companyList = await getExecutor().many('SELECT id, name FROM companies ORDER BY name', []);
    const m = await companyGrantMatrix();
    grants = Object.fromEntries([...m.entries()].map(([uid, set]) => [uid, [...set]]));
  } catch (e) {
    schemaWarning = 'ייתכן שנדרש עדכון מסד נתונים — לחץ "עדכן מסד נתונים".';
  }
  try {
    roleTemplates = await listRoleTemplates();
  } catch (e) {
    // role_templates table may predate this feature on the live DB — the owner can create it
    // with "עדכן מסד נתונים". Render the rest of the page regardless.
    schemaWarning = schemaWarning || 'ייתכן שנדרש עדכון מסד נתונים — לחץ "עדכן מסד נתונים".';
  }
  res.render('settings/index', {
    title: 'הגדרות',
    companies,
    users,
    companyList,
    grants,
    roleTemplates,
    permissionCatalog: PERMISSIONS,
    rolePresets: ROLE_PRESETS,
    error: null,
    notice: null,
    schemaWarning,
    invite: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await render(req, res);
  } catch (err) {
    next(err);
  }
});

// Team user guide — page-by-page reference. Gated by the settings router (requirePermission).
router.get('/guide', (req, res) => {
  res.render('settings/guide', { title: 'מדריך למשתמש' });
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

// Generate a set-password link and show a "פתח וואטסאפ" button (owner picks the contact).
router.post('/users/:id/invite', async (req, res, next) => {
  try {
    const result = await createInviteLink(Number(req.params.id), { origin: origin(req) }, getExecutor());
    if (!result) return render(req, res, { error: 'משתמש לא נמצא' });
    const invite = { userId: result.user.id, name: result.user.name, link: result.link, waUrl: whatsappUrl(result.user, result.link) };
    await render(req, res, { notice: `נוצר קישור הזמנה ל-${result.user.name}. לחץ "פתח וואטסאפ" לשליחה.`, invite });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Set a user's company access (הפרדת חברות matrix).
router.post('/users/:id/companies', async (req, res, next) => {
  try {
    const companyIds = [].concat(req.body.companies || []).map(Number).filter(Boolean);
    await setUserCompanies(Number(req.params.id), companyIds, getExecutor());
    await render(req, res, { notice: 'הרשאות החברה עודכנו.' });
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

// --- Role templates (owner-only): named permission presets applied to a user in one click. ---
router.post('/role-templates', requireOwner, async (req, res, next) => {
  try {
    await createRoleTemplate({ name: req.body.name, permissions: req.body.permissions }, req.user);
    await render(req, res, { notice: 'תבנית תפקיד נוספה.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/role-templates/:id', requireOwner, async (req, res, next) => {
  try {
    await updateRoleTemplate(Number(req.params.id), { name: req.body.name, permissions: req.body.permissions }, req.user);
    await render(req, res, { notice: 'תבנית התפקיד עודכנה.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/role-templates/:id/delete', requireOwner, async (req, res, next) => {
  try {
    await deleteRoleTemplate(Number(req.params.id), req.user);
    await render(req, res, { notice: 'תבנית התפקיד נמחקה.' });
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

// Full backup download (owner-only): a complete JSON snapshot of every table. The owner keeps
// this file somewhere they control (Drive / disk). Images live in Blob and are referenced by path.
router.get('/backup', requireOwner, async (req, res, next) => {
  try {
    const data = await exportAll();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ap-control-backup-${date}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
});

// Verify the acting owner's own account password — the gate for the destructive actions below.
async function ownerPasswordOk(req) {
  const row = await getExecutor().one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  return !!row && verifyPassword(req.body.password || '', row.password_hash);
}

// "Start fresh" (owner-only): wipe transactional data + its Blob images, keep the setup. Guarded
// by the owner's own password so it can't be triggered by accident.
router.post('/reset-data', requireOwner, async (req, res, next) => {
  try {
    if (!(await ownerPasswordOk(req))) {
      return render(req, res, { error: 'האיפוס לא בוצע — סיסמת הבעלים שגויה.' });
    }
    const { deletedImages } = await resetTransactionalData(
      { alsoSuppliers: req.body.also_suppliers === '1' },
      req.user,
    );
    const supMsg = req.body.also_suppliers === '1' ? ' (כולל ספקים)' : '';
    await render(req, res, {
      notice: `הנתונים אופסו${supMsg}. נמחקו ${deletedImages} תמונות. ההגדרה (חברות/חנויות/חשבונות/משתמשים) נשמרה.`,
    });
  } catch (err) {
    next(err);
  }
});

// Restore from a backup JSON (owner-only). REPLACES all data with the file's snapshot,
// atomically. Guarded by a typed confirmation because it overwrites everything.
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } }).single('backup');
router.post('/restore', requireOwner, (req, res, next) => {
  backupUpload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) throw new RuleError('RESTORE', 'העלאת הקובץ נכשלה (מוגבל ל-50MB).');
      if (!(await ownerPasswordOk(req))) {
        return render(req, res, { error: 'השחזור לא בוצע — סיסמת הבעלים שגויה.' });
      }
      if (!req.file) throw new RuleError('RESTORE', 'לא נבחר קובץ גיבוי.');
      let dump;
      try {
        dump = JSON.parse(req.file.buffer.toString('utf8'));
      } catch {
        throw new RuleError('RESTORE', 'הקובץ אינו JSON תקין.');
      }
      const { restored } = await restoreAll(dump, req.user);
      const total = Object.values(restored).reduce((a, b) => a + b, 0);
      await render(req, res, { notice: `השחזור הושלם — ${total} רשומות שוחזרו מהגיבוי.` });
    } catch (err) {
      if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
      next(err);
    }
  });
});

export default router;
