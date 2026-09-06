import { Router } from 'express';
import multer from 'multer';
import {
  listEmployees, createEmployee, deleteEmployee, listEmployeeLedger, employeeTotals, importEmployees,
  setEmployeeStores,
} from '../services/employees.js';
import { scopedStoreList } from '../lib/scope.js';
import { assertStoreAllowed } from '../lib/scopeGuard.js';
import { parseEmployeeFile } from '../lib/employeeImport.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

const staffUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('file');

// Posted store ids must be ones the caller may access, or an employee could be linked into a
// store they cannot see (and would then appear in that store's pickers).
async function allowedStoreIds(body, scope) {
  const ids = [...new Set([].concat(body.store_ids || []).map(Number).filter(Boolean))];
  for (const id of ids) await assertStoreAllowed(id, scope);
  return ids;
}

// The summary table joined to the SCOPED employee list: rows the caller may not see are dropped,
// and each surviving row carries its `stores` so the screen can show where the employee works.
async function scopedTotals(scope) {
  const visible = await listEmployees({ includeInactive: true, scope });
  const byId = new Map(visible.map((e) => [Number(e.id), e]));
  const rows = await employeeTotals();
  return rows
    .filter((r) => byId.has(Number(r.id)))
    .map((r) => ({ ...r, stores: byId.get(Number(r.id)).stores || [] }));
}

async function render(req, res, extra = {}) {
  res.render('employees/index', {
    title: 'עובדים ומשכורות',
    // Scoped: an employee linked to stores is only visible where one of them is in scope; an
    // employee with no links is shared with every store (see services/employees.js#listEmployees).
    storeOptions: await scopedStoreList(req.scope),
    totals: await scopedTotals(req.scope),
    ledger: await listEmployeeLedger(),
    error: null,
    notice: null,
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

router.post('/', async (req, res, next) => {
  try {
    const storeIds = await allowedStoreIds(req.body, req.scope);
    const emp = await createEmployee(
      { firstName: req.body.first_name, lastName: req.body.last_name, phone: req.body.phone },
      req.user,
    );
    if (storeIds.length) await setEmployeeStores(emp.id, storeIds, req.user);
    await render(req, res, {
      notice: storeIds.length ? 'העובד נוסף ושויך לחנויות שנבחרו.' : 'העובד נוסף (משויך לכל החנויות).',
    });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Assign / copy an employee to stores. Ticking a second store is exactly the "copy to another
// branch" case: one employee row, working at both, visible in both.
router.post('/:id/stores', async (req, res, next) => {
  try {
    const storeIds = await allowedStoreIds(req.body, req.scope);
    await setEmployeeStores(Number(req.params.id), storeIds, req.user);
    await render(req, res, {
      notice: storeIds.length ? 'שיוך החנויות עודכן.' : 'השיוך נוקה — העובד משויך כעת לכל החנויות.',
    });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Bulk import from an Excel/CSV staff list (name + phone). Existing employees (matched by phone)
// are skipped so the list never gains duplicates.
router.post('/import', (req, res, next) => {
  staffUpload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) throw new RuleError('IMPORT', 'העלאת הקובץ נכשלה (מקסימום 5MB).');
      if (!req.file) throw new RuleError('IMPORT', 'לא נבחר קובץ.');
      let parsed;
      try {
        parsed = parseEmployeeFile(req.file.buffer);
      } catch (e) {
        throw new RuleError('IMPORT', 'לא ניתן לקרוא את הקובץ. ודא שהוא Excel (.xlsx) או CSV עם כותרות (שם, טלפון).');
      }
      if (!parsed.rows.length) throw new RuleError('IMPORT', 'לא נמצאו עובדים בקובץ. צריך עמודת שם (ואפשר גם טלפון).');
      const { added, skipped, invalid } = await importEmployees(parsed.rows, req.user);
      const bits = [`נוספו ${added} עובדים`];
      if (skipped) bits.push(`${skipped} כבר קיימים (לפי טלפון) — לא נוספו`);
      if (invalid) bits.push(`${invalid} שורות ללא שם — דולגו`);
      await render(req, res, { notice: bits.join(' · ') + '.' });
    } catch (err) {
      if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
      next(err);
    }
  });
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const r = await deleteEmployee(Number(req.params.id), req.user);
    await render(req, res, { notice: r.deactivated ? 'העובד הועבר ללא-פעיל (יש לו רישומים).' : 'העובד נמחק.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

export default router;
