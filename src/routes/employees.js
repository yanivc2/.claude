import { Router } from 'express';
import multer from 'multer';
import {
  listEmployees, createEmployee, deleteEmployee, listEmployeeLedger, employeeTotals, importEmployees,
  setEmployeeStores,
} from '../services/employees.js';
import { scopedStoreList, assignmentScope, effectiveStoreId } from '../lib/scope.js';
import {
  listSalaryPayments, createSalaryPayment, deleteSalaryPayment, markCashed, unmatchCashed,
  cashExpenseCandidates, SALARY_METHODS,
} from '../services/salaryPayments.js';
import { salaryPaymentsReady } from '../services/voidedChecks.js';
import { toAgorot } from '../lib/money.js';
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
  // The wage rubric is per store: the picker offers only THIS branch's employees, and the rows
  // shown are this branch's. With no active store the owner sees every branch they may see.
  const storeId = effectiveStoreId(req, req.query.store);
  // The wage table arrives with a schema upgrade the owner runs by hand. Until then the rubric says
  // so instead of the page dying on "no such table: salary_payments".
  const salaryReady = await salaryPaymentsReady();
  res.render('employees/index', {
    title: 'עובדים ומשכורות',
    salaryReady,
    salaryRows: salaryReady ? await listSalaryPayments({ storeId, scope: req.scope }) : [],
    salaryMethods: SALARY_METHODS,
    cashCandidates: salaryReady ? await cashExpenseCandidates({ storeId, scope: req.scope }) : [],
    salaryStoreId: storeId,
    // Scoped: an employee linked to stores is only visible where one of them is in scope; an
    // employee with no links is shared with every store (see services/employees.js#listEmployees).
    storeOptions: await scopedStoreList(assignmentScope(req)),
    totals: await scopedTotals(req.scope),
    ledger: await listEmployeeLedger(),
    error: null,
    notice: null,
    ...extra,
  });
}

// POST/Redirect/GET: every action below redirects here with a short code instead of rendering in
// place. Rendering worked, but it left the browser parked on a POST-only URL — a reload or a PWA
// restore then issued a GET to e.g. /employees/54/stores and hit the "not found" page, with the
// save already done. The notice has to survive the redirect, so it travels as a code.
const NOTICES = {
  added: 'העובד נוסף (משויך לכל החנויות).',
  'added-stores': 'העובד נוסף ושויך לחנויות שנבחרו.',
  stores: 'שיוך החנויות עודכן.',
  'stores-cleared': 'השיוך נוקה — העובד משויך כעת לכל החנויות.',
  imported: 'הייבוא הושלם.',
  deleted: 'העובד נמחק.',
  deactivated: 'העובד הועבר ללא-פעיל (יש לו רישומים).',
  salary: 'תשלום השכר נרשם.',
  'salary-deleted': 'תשלום השכר נמחק.',
  cashed: 'הצ׳ק סומן כנפרט והותאם להוצאת המזומן. הצ׳ק בוטל ונמצא במעקב ב"צ׳קים מבוטלים".',
  uncashed: 'ההתאמה בוטלה. הצ׳ק שבוטל נשאר במעקב.',
};

router.get('/', async (req, res, next) => {
  try {
    await render(req, res, { notice: NOTICES[req.query.saved] || null });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const storeIds = await allowedStoreIds(req.body, assignmentScope(req));
    const emp = await createEmployee(
      { firstName: req.body.first_name, lastName: req.body.last_name, phone: req.body.phone },
      req.user,
    );
    if (storeIds.length) await setEmployeeStores(emp.id, storeIds, req.user);
    return res.redirect(303, `/employees?saved=${storeIds.length ? 'added-stores' : 'added'}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Assign / copy an employee to stores. Ticking a second store is exactly the "copy to another
// branch" case: one employee row, working at both, visible in both.
router.post('/:id/stores', async (req, res, next) => {
  try {
    const storeIds = await allowedStoreIds(req.body, assignmentScope(req));
    await setEmployeeStores(Number(req.params.id), storeIds, req.user);
    return res.redirect(303, `/employees?saved=${storeIds.length ? 'stores' : 'stores-cleared'}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// --- תשלומי שכר -------------------------------------------------------------------------------
// Recording HOW a wage was paid, and the one case that is not just bookkeeping: an employee who
// cashes the wage check at the till. See services/salaryPayments.js.

router.post('/salary', async (req, res, next) => {
  try {
    const storeId = await assertStoreAllowed(req.body.store_id, req.scope);
    await createSalaryPayment(
      {
        storeId,
        employeeId: req.body.employee_id,
        method: req.body.method,
        reference: req.body.reference,
        dueDate: req.body.due_date,
        amount: toAgorot(req.body.amount || '0'),
      },
      req.user,
    );
    return res.redirect(303, '/employees?saved=salary');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// "הצ׳ק נפרט" — tie the wage row to the Z-closing cash expense that paid it out at the till, and
// void the underlying check so the same wage is not paid twice.
router.post('/salary/:id/cashed', async (req, res, next) => {
  try {
    await markCashed(Number(req.params.id), Number(req.body.cash_expense_id), req.user);
    return res.redirect(303, '/employees?saved=cashed');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/salary/:id/uncashed', async (req, res, next) => {
  try {
    await unmatchCashed(Number(req.params.id), req.user);
    return res.redirect(303, '/employees?saved=uncashed');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/salary/:id/delete', async (req, res, next) => {
  try {
    await deleteSalaryPayment(Number(req.params.id), req.user);
    return res.redirect(303, '/employees?saved=salary-deleted');
  } catch (err) {
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
    return res.redirect(303, `/employees?saved=${r.deactivated ? 'deactivated' : 'deleted'}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

export default router;
