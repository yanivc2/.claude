import { Router, json } from 'express';
import multer from 'multer';
import {
  listStructure,
  createCompany,
  updateCompany,
  createStoreWithAccount,
  updateAccountDisplayName,
  deleteStore,
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
import { companyGrantMatrix, setUserCompanies, storeGrantMatrix, setUserStores } from '../lib/scope.js';
import { verifyPassword, generatePassword } from '../lib/auth.js';
import { exportAll, resetTransactionalData, restoreAll, cleanStartInvoicesPaymentsZ } from '../services/backup.js';
import { setScanEnabled } from '../services/appSettings.js';
import { storageSelfTest } from '../lib/storage.js';
import { sendTelegramDetailed, telegramConfigured } from '../lib/notify.js';
import { importCatalogItems } from '../services/masterCatalog.js';
import { parseCatalogFile, parseCatalogRows, mapHeaders } from '../lib/catalogFile.js';
import { parseSupplierCatalog } from '../lib/supplierCatalogFile.js';
import { importSupplierCatalog, supplierCatalogSummary } from '../services/supplierCatalog.js';
import { looksLikeXlsx } from '../lib/xlsxRead.js';
import { decodeBuffer } from '../lib/decodeText.js';
import { listRoleTemplates, createRoleTemplate, updateRoleTemplate, deleteRoleTemplate } from '../services/roleTemplates.js';
import { createInviteLink } from '../services/passwordReset.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

function isHttps(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
function origin(req) { return `${isHttps(req) ? 'https' : req.protocol}://${req.get('host')}`; }

// The WhatsApp onboarding message: notice + clickable app link + password (in a monospace block
// so it copies on its own) + how to add the app to the phone's home screen.
function buildInviteMessage(user, appUrl, password) {
  return [
    `שלום ${user.name || ''} 👋`,
    `נפתח עבורך חשבון ב-AP Control, ושלחתי לך קישור להתחברות לאפליקציה.`,
    '',
    '🔗 כניסה לאפליקציה (לחיצה על הקישור):',
    `${appUrl}/login`,
    '',
    `👤 שם משתמש: ${user.username || ''}`,
    '🔑 הסיסמה שלך (לחיצה ארוכה כדי להעתיק):',
    '```' + password + '```',
    '',
    'מומלץ להחליף סיסמה אחרי הכניסה הראשונה: הגדרות ‹ הסיסמה שלי.',
    '',
    '📲 הוספה למסך הבית של הנייד:',
    '• אייפון (Safari): כפתור השיתוף ⬆️ ← "הוסף למסך הבית".',
    '• אנדרואיד (Chrome): תפריט ⋮ ← "הוספה למסך הבית".',
  ].join('\n');
}

// WhatsApp message for a SELF-SETUP link: the invitee opens it and chooses their own username +
// password (no password is sent). Includes the home-screen install tip.
function buildLinkInviteMessage(user, link) {
  return [
    `שלום ${user.name || ''} 👋`,
    `נפתח עבורך חשבון ב-AP Control. לחץ על הקישור כדי לבחור שם משתמש וסיסמה משלך:`,
    '',
    '🔗 הגדרת החשבון:',
    link,
    '',
    '(הקישור אישי ותקף ל-7 ימים.)',
    '',
    '📲 הוספה למסך הבית של הנייד:',
    '• אייפון (Safari): כפתור השיתוף ⬆️ ← "הוסף למסך הבית".',
    '• אנדרואיד (Chrome): תפריט ⋮ ← "הוספה למסך הבית".',
  ].join('\n');
}

// Build the wa.me deep link (international phone, or no number so WhatsApp lets you pick a contact).
function whatsappDeepLink(user, message) {
  let phone = String(user.phone || '').replace(/\D/g, '');
  if (phone && !phone.startsWith('972')) phone = phone.startsWith('0') ? `972${phone.slice(1)}` : `972${phone}`;
  const base = phone ? `https://wa.me/${phone}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
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
  let storeGrants = {}; // { userId: [storeId, ...] } for the per-store grant layer
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
    const sm = await storeGrantMatrix();
    storeGrants = Object.fromEntries([...sm.entries()].map(([uid, set]) => [uid, [...set]]));
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
  let suppliersList = [];
  let supplierCatalogs = [];
  try {
    suppliersList = await getExecutor().many('SELECT id, name FROM suppliers ORDER BY name', []);
    supplierCatalogs = await supplierCatalogSummary();
  } catch (e) {
    // supplier_catalog may predate this feature on the live DB — "עדכן מסד נתונים" creates it.
    schemaWarning = schemaWarning || 'ייתכן שנדרש עדכון מסד נתונים — לחץ "עדכן מסד נתונים".';
  }
  res.render('settings/index', {
    title: 'הגדרות',
    companies,
    users,
    suppliersList,
    supplierCatalogs,
    companyList,
    grants,
    storeGrants,
    roleTemplates,
    permissionCatalog: PERMISSIONS,
    rolePresets: ROLE_PRESETS,
    error: null,
    notice: null,
    schemaWarning,
    telegramReady: telegramConfigured(),
    invite: null,
    linkInvite: null,
    ...extra,
  });
}

/**
 * Finish a successful action with Post/Redirect/Get.
 *
 * Rendering the page straight from the POST leaves the browser sitting on a URL that only accepts
 * POST — so the next reload (or a back/forward restore, which Safari does eagerly because every
 * dynamic response is no-store) issues a GET and gets a 404. The owner pressed "עדכון מסד נתונים",
 * the upgrade ran fine, and then the refresh told them the page did not exist.
 *
 * Redirecting also removes the browser's "resubmit this form?" prompt, which for a destructive
 * action like restore-from-backup is a genuinely dangerous thing to leave lying around.
 */
function done(res, notice) {
  return res.redirect(303, '/settings?ok=' + encodeURIComponent(notice));
}

router.get('/', async (req, res, next) => {
  try {
    // `ok` carries the message across the redirect done() performs after a successful action.
    await render(req, res, { notice: req.query.ok ? String(req.query.ok) : null });
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
    return done(res, 'חברה נוספה.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/companies/:id', async (req, res, next) => {
  try {
    await updateCompany(Number(req.params.id), { name: req.body.name, taxId: req.body.tax_id }, req.user);
    return done(res, 'פרטי החברה עודכנו.');
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
    return done(res, 'חנות וחשבון בנק נוספו.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Delete a store (+ its bank account) — owner only, refused if it has any transactional history.
router.post('/stores/:id/delete', async (req, res, next) => {
  try {
    await deleteStore(Number(req.params.id), req.user);
    return done(res, 'החנות נמחקה.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/accounts/:id', async (req, res, next) => {
  try {
    await updateAccountDisplayName(Number(req.params.id), req.body.display_name, req.user);
    return done(res, 'שם התצוגה של החשבון עודכן.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// --- Owner's own password (moved here from the header) ---
router.post('/password', async (req, res, next) => {
  try {
    await changeOwnPassword(req.user.id, { current: req.body.current, next: req.body.next, confirm: req.body.confirm });
    return done(res, 'הסיסמה שלך עודכנה.');
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
        loginStart: req.body.login_start, loginEnd: req.body.login_end,
      },
      req.user,
    );
    return done(res, 'משתמש נוסף.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/users/:id', async (req, res, next) => {
  try {
    await updateUser(
      Number(req.params.id),
      {
        name: req.body.name, email: req.body.email, role: req.body.role, label: req.body.label,
        permissions: req.body.permissions, loginStart: req.body.login_start, loginEnd: req.body.login_end,
      },
      req.user,
    );
    return done(res, 'פרטי המשתמש עודכנו.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    await resetPasswordByOwner(Number(req.params.id), req.body.password, req.user);
    return done(res, 'הסיסמה אופסה.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Set a fresh temporary password for the user and prepare a ready-to-send WhatsApp message
// (app link + password + home-screen instructions). Owner picks the contact in WhatsApp.
router.post('/users/:id/invite', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const x = getExecutor();
    const user = await x.one('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) return render(req, res, { error: 'משתמש לא נמצא' });

    // Optional: set/change the login username right here (validated unique).
    const newUsername = (req.body.username || '').trim();
    if (newUsername && newUsername !== user.username) {
      const dup = await x.one('SELECT id FROM users WHERE username = ? AND id <> ?', [newUsername, id]);
      if (dup) return render(req, res, { error: `שם המשתמש "${newUsername}" כבר קיים.` });
      await x.run('UPDATE users SET username = ? WHERE id = ?', [newUsername, id]);
      user.username = newUsername;
    }
    if (!user.username) return render(req, res, { error: 'הזן שם משתמש (לוגין) עבור המשתמש.' });

    // Optional: a custom temporary password typed by the owner, otherwise auto-generate one.
    const custom = (req.body.password || '').trim();
    const password = custom || generatePassword();
    await resetPasswordByOwner(id, password, req.user); // validates the policy + sets must_change

    const appUrl = origin(req);
    const message = buildInviteMessage(user, appUrl, password);
    const invite = {
      userId: id, name: user.name, username: user.username, password,
      loginUrl: `${appUrl}/login`, message, waUrl: whatsappDeepLink(user, message),
    };
    await render(req, res, { notice: `מוכן לשליחה ל-${user.name}. ניתן לערוך שם משתמש/סיסמה ולהכין מחדש.`, invite });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Generate a SELF-SETUP link: the invitee opens it and picks their own username + password. No
// password is set here. Prepares a ready-to-send WhatsApp message (owner picks the contact).
router.post('/users/:id/invite-link', requireOwner, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const made = await createInviteLink(id, { origin: origin(req) });
    if (!made) return render(req, res, { error: 'משתמש לא נמצא' });
    const { user, link } = made;
    const message = buildLinkInviteMessage(user, link);
    const linkInvite = {
      userId: id, name: user.name, link, message, waUrl: whatsappDeepLink(user, message),
    };
    await render(req, res, { notice: `קישור הגדרה עצמית מוכן ל-${user.name}. המשתמש יבחר שם משתמש וסיסמה בעצמו.`, linkInvite });
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
    return done(res, 'הרשאות החברה עודכנו.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Set a user's per-store access (הרשאה פר-חנות matrix). No rows = fall back to all stores in the
// user's granted companies; rows here pin the user to exactly those stores.
router.post('/users/:id/stores', async (req, res, next) => {
  try {
    const storeIds = [].concat(req.body.stores || []).map(Number).filter(Boolean);
    await setUserStores(Number(req.params.id), storeIds, getExecutor());
    return done(res, 'הרשאות החנות עודכנו.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/users/:id/delete', async (req, res, next) => {
  try {
    await deleteUser(Number(req.params.id), req.user);
    return done(res, 'המשתמש נמחק.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// --- Role templates (owner-only): named permission presets applied to a user in one click. ---
router.post('/role-templates', requireOwner, async (req, res, next) => {
  try {
    await createRoleTemplate({ name: req.body.name, permissions: req.body.permissions }, req.user);
    return done(res, 'תבנית תפקיד נוספה.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/role-templates/:id', requireOwner, async (req, res, next) => {
  try {
    await updateRoleTemplate(Number(req.params.id), { name: req.body.name, permissions: req.body.permissions }, req.user);
    return done(res, 'תבנית התפקיד עודכנה.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/role-templates/:id/delete', requireOwner, async (req, res, next) => {
  try {
    await deleteRoleTemplate(Number(req.params.id), req.user);
    return done(res, 'תבנית התפקיד נמחקה.');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// One-click DB schema upgrade (idempotent) — adds any columns/tables a new deploy needs. Owner-only.
router.post('/db-upgrade', requireOwner, async (req, res, next) => {
  try {
    const failures = await upgradeSchema();
    if (Array.isArray(failures) && failures.length) {
      // Some (idempotent) statements couldn't apply, but the rest did. Surface which, so a single
      // problematic migration doesn't silently mask that everything else succeeded.
      const list = failures.slice(0, 5).map((f) => `• ${f.message}`).join('\n');
      return done(res, `מסד הנתונים עודכן. ${failures.length} משפטים דולגו (השאר הוחלו): \n${list}`);
    } else {
      return done(res, 'מסד הנתונים עודכן בהצלחה — כל העמודות והטבלאות החדשות קיימות.');
    }
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

// Owner toggle: unlock/lock the invoice-scan feature (the future scan package's on/off switch).
router.post('/scan-toggle', requireOwner, async (req, res, next) => {
  try {
    const on = req.body.on === '1';
    await setScanEnabled(on);
    await render(req, res, { notice: on ? 'צילום חשבוניות הופעל.' : 'צילום חשבוניות ננעל.' });
  } catch (err) {
    next(err);
  }
});

// Telegram self-test (owner-only): send a test message and report the exact outcome, so a silent
// no-op (missing token / user never pressed Start / wrong chat_id) becomes a visible reason.
router.post('/telegram-test', requireOwner, async (req, res, next) => {
  try {
    const r = await sendTelegramDetailed(`בדיקת טלגרם מ-AP Control ✅ — אם קיבלת הודעה זו, ההתראות פעילות.`);
    await render(req, res, { notice: (r.ok ? '✅ ' : '⚠️ ') + r.detail });
  } catch (err) {
    next(err);
  }
});

// "Clean start" (owner-only): wipe invoices, payments, and Z reports (+ scan drafts) but KEEP the
// register closings, suppliers, catalog, employees, bank imports and setup. Owner-password guarded.
router.post('/clean-start', requireOwner, async (req, res, next) => {
  try {
    if (!(await ownerPasswordOk(req))) {
      return render(req, res, { error: 'הפעולה לא בוצעה — סיסמת הבעלים שגויה.' });
    }
    const { counts, deletedImages } = await cleanStartInvoicesPaymentsZ(req.user);
    await render(req, res, {
      notice: `נמחקו ${counts.invoices} חשבוניות, ${counts.payments} תשלומים, ${counts.zReports} דוחות Z ו-${counts.drafts} טיוטות סריקה (${deletedImages} תמונות). סגירות ה-Z, הספקים, הקטלוג והעובדים נשמרו.`,
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
      return done(res, `השחזור הושלם — ${total} רשומות שוחזרו מהגיבוי.`);
    } catch (err) {
      if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
      next(err);
    }
  });
});

// ── Master-catalog upload (owner-only) ──────────────────────────────────────────────────────
// Additive: it inserts new barcodes and updates existing ones, and never deletes — so
// re-uploading a newer file is always safe, and so is re-running one that stopped halfway.
//
// There are two ways in. The batched pair below is the normal one: the browser reads the file
// itself (public/catalog-upload.js) and posts rows a few thousand at a time, because Vercel
// rejects a request body over ~4.5MB at the platform edge and the owner's workbook is 5.8MB.
// The single-shot form POST further down still works, and is what a browser without
// DecompressionStream falls back to.

/** Hebrew for "the file's first row isn't a header we understand". */
const BAD_HEADER = 'לא נמצאו העמודות "ברקוד" ו"שם" בשורת הכותרות. הקובץ צריך להיות XLSX או CSV עם כותרות בעברית בשורה הראשונה.';

const asRow = (r) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? '' : String(c))) : []);

/** Answer a JSON route: a rule/auth problem is the client's to fix, anything else is ours. */
function jsonFail(res, err) {
  const known = err instanceof RuleError || err instanceof AuthError;
  if (!known) console.error(err); // eslint-disable-line no-console
  return res.status(known ? 400 : 500).json({ error: err.message });
}

// Step 1 of a batched import: validate the header once, and answer with the column indexes worth
// sending. Everything that can be known before the owner waits through a large file is checked
// here — including whether the live schema still predates master_catalog.sku, which would
// otherwise surface as a raw Postgres error on the first batch.
router.post('/catalog-import/prepare', requireOwner, json({ limit: '256kb' }), async (req, res) => {
  try {
    const fields = mapHeaders(asRow(req.body?.header));
    if (!fields.includes('barcode') || !fields.includes('name')) {
      throw new RuleError('CATALOG', BAD_HEADER);
    }
    try {
      await getExecutor().one('SELECT sku FROM master_catalog LIMIT 1', []);
    } catch {
      throw new RuleError('CATALOG', 'מסד הנתונים עדיין לא עודכן לגרסה הזו. לחץ "עדכן מסד נתונים" כאן בהגדרות, ואז טען את הקטלוג שוב.');
    }
    const keep = [];
    fields.forEach((f, i) => { if (f && f !== 'ignore') keep.push(i); });
    return res.json({ keep });
  } catch (err) {
    return jsonFail(res, err);
  }
});

// Step 2: one batch of rows. Stateless — the client echoes the (already narrowed) header with
// every batch, so nothing is held between requests and the mapping still comes from mapHeaders.
router.post('/catalog-import/batch', requireOwner, json({ limit: '4mb' }), async (req, res) => {
  try {
    const fields = mapHeaders(asRow(req.body?.header));
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.map(asRow) : [];
    const { items, stats } = parseCatalogRows(fields, rows);
    if (!stats.columns.includes('barcode') || !stats.columns.includes('name')) {
      throw new RuleError('CATALOG', BAD_HEADER);
    }
    const source = String(req.body?.source || '').trim() || 'קובץ שהועלה';
    const result = items.length
      ? await importCatalogItems(items, { chain: source, store: null })
      : { inserted: 0, updated: 0, unchanged: 0 };
    return res.json({ ...stats, ...result });
  } catch (err) {
    return jsonFail(res, err);
  }
});

const catalogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 } }).single('catalog');
router.post('/catalog-import', requireOwner, (req, res, next) => {
  catalogUpload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) throw new RuleError('CATALOG', 'העלאת הקובץ נכשלה (מוגבל ל-40MB).');
      if (!req.file) throw new RuleError('CATALOG', 'לא נבחר קובץ.');
      // Vercel refuses a body over ~4.5MB before Express is reached, so a large file never gets
      // here at all — but say something useful in the sliver of cases that do (a bigger limit
      // locally, a proxy that buffers) rather than letting it look like it worked.
      if (req.file.size > 4 * 1024 * 1024) {
        throw new RuleError('CATALOG', 'הקובץ גדול מ-4MB ולא ניתן להעלות אותו כך. פתח את המסך מדפדפן עדכני (Chrome/Safari) — הוא קורא את הקובץ במחשב ושולח אותו במנות.');
      }

      // Sniff the bytes rather than trusting the extension: an .xlsx is a zip and must reach the
      // parser as a Buffer, while a text file goes through decodeBuffer so a Windows-1255 export
      // is not mangled into question marks.
      const raw = req.file.buffer;
      const { items, stats } = parseCatalogFile(looksLikeXlsx(raw) ? raw : decodeBuffer(raw));
      if (!stats.columns.includes('barcode') || !stats.columns.includes('name')) {
        throw new RuleError('CATALOG', BAD_HEADER);
      }
      if (items.length === 0) throw new RuleError('CATALOG', 'לא נמצאה אף שורה תקינה בקובץ.');

      const source = (req.body.source_name || '').trim() || 'קובץ שהועלה';
      const result = await importCatalogItems(items, { chain: source, store: null });

      // The repair count is reported, never hidden: a spreadsheet round trip silently strips
      // leading zeros from barcodes, and the owner should know it happened to their file.
      const parts = [
        `הקטלוג עודכן — נוספו ${result.inserted}, עודכנו ${result.updated}, ללא שינוי ${result.unchanged}.`,
      ];
      if (stats.repaired) {
        parts.push(`⚠ ${stats.repaired} ברקודים הגיעו בלי אפסים מובילים (סימן שהקובץ נערך באקסל) ותוקנו לפי ספרת הביקורת.`);
      }
      const dropped = stats.noBarcode + stats.badBarcode + stats.duplicate;
      if (dropped) {
        parts.push(`דולגו ${dropped} שורות: ${stats.noBarcode} בלי ברקוד או שם, ${stats.badBarcode} ברקוד לא תקין, ${stats.duplicate} כפולות.`);
      }
      return done(res, parts.join(' '));
    } catch (err) {
      if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
      next(err);
    }
  });
});

// ── Supplier-catalog upload (owner-only) ────────────────────────────────────────────────────
// The catalog a supplier hands over, listing what IT sells. Unlike the קטלוג-על this is scoped
// to one supplier and is small — the three tobacco files are 51-108 rows, ~20KB — so it goes up
// in one request with no need for the browser-side chunking the big catalog requires.
const supplierCatalogUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
}).single('catalog');

router.post('/supplier-catalog-import', requireOwner, (req, res, next) => {
  supplierCatalogUpload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) throw new RuleError('CATALOG', 'העלאת הקובץ נכשלה (מוגבל ל-4MB).');
      if (!req.file) throw new RuleError('CATALOG', 'לא נבחר קובץ.');
      const supplierId = Number(req.body.supplier_id);
      if (!Number.isFinite(supplierId) || supplierId <= 0) {
        throw new RuleError('CATALOG', 'יש לבחור ספק.');
      }
      const supplier = await getExecutor().one('SELECT id, name FROM suppliers WHERE id = ?', [supplierId]);
      if (!supplier) throw new RuleError('CATALOG', 'הספק לא נמצא.');

      const raw = req.file.buffer;
      const { items, warnings, stats } = parseSupplierCatalog(looksLikeXlsx(raw) ? raw : decodeBuffer(raw));
      if (!items.length) {
        throw new RuleError('CATALOG', warnings[0] || 'לא נמצאה אף שורה תקינה בקובץ.');
      }

      const result = await importSupplierCatalog(supplierId, items);
      const parts = [
        `הקטלוג של ${supplier.name} נטען — ${result.imported} שורות, ${stats.products} מוצרים ` +
          `(${stats.boxes} קופסה, ${stats.cartons} פאקט).`,
      ];
      if (result.replaced) parts.push(`הוחלף קטלוג קודם בן ${result.replaced} שורות.`);
      // Skips are reported rather than swallowed: a row dropped for a bad check digit is a row
      // that will never be identified, and the owner is the only one who can fix the file.
      if (stats.skipped) parts.push(`דולגו ${stats.skipped} שורות.`);
      for (const w of warnings) parts.push(`⚠ ${w}`);
      return done(res, parts.join(' '));
    } catch (err) {
      if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
      next(err);
    }
  });
});

// Storage self-test (owner-only). "The photos don't open" is not reproducible off the real store:
// uploads clearly work, the read fails, and until now nothing was logged. This writes a tiny file,
// reads it back and deletes it, reporting each step — one click instead of a deploy cycle.
router.post('/storage-test', requireOwner, async (req, res, next) => {
  try {
    const result = await storageSelfTest();
    const detail = result.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`).join(' · ');
    const where = result.access === 'n/a' ? result.backend : `${result.backend}, ${result.access}`;
    return done(res, `${result.ok ? '✅ אחסון הקבצים תקין' : '❌ בדיקת האחסון נכשלה'} (${where}) — ${detail}`);
  } catch (err) {
    next(err);
  }
});

// A GET on any action path (a reload of an old POST URL, a bookmark) is not a 404 — it is
// someone who is already where they meant to be.
router.get(
  ['/db-upgrade', '/catalog-import', '/supplier-catalog-import', '/storage-test', '/restore', '/reset-data', '/clean-start', '/scan-toggle', '/password', '/users', '/companies', '/stores'],
  (req, res) => res.redirect(303, '/settings'),
);

export default router;
