import { Router } from 'express';
import multer from 'multer';
import {
  listEmployees, createEmployee, deleteEmployee, listEmployeeLedger, employeeTotals, importEmployees,
} from '../services/employees.js';
import { parseEmployeeFile } from '../lib/employeeImport.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

const staffUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('file');

async function render(req, res, extra = {}) {
  res.render('employees/index', {
    title: 'עובדים ומשכורות',
    totals: await employeeTotals(),
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
    await createEmployee({ firstName: req.body.first_name, lastName: req.body.last_name, phone: req.body.phone }, req.user);
    await render(req, res, { notice: 'העובד נוסף.' });
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
