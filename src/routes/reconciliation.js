import { Router } from 'express';
import multer from 'multer';
import { getExecutor } from '../db/adapter.js';
import { scopeClause, scopeWhere } from '../lib/scope.js';
import { assertInScope } from '../lib/scopeGuard.js';
import { toAgorot, fromAgorot } from '../lib/money.js';
import { parseCsv } from '../lib/csv.js';
import { parseXlsx } from '../lib/xlsx.js';
import { normalizeBankRows } from '../lib/bankCsv.js';
import { decodeBuffer, decodeFileName } from '../lib/decodeText.js';
import { RuleError, AuthError, NotFoundError } from '../lib/errors.js';
import { requirePermission } from '../middleware/requireOwner.js';
import {
  importTransactions,
  listImports,
  importsReady,
  untrackedSummary,
  deleteTransactions,
  matchRowsToTransactions,
  getImport,
  deleteImport,
  listUnmatched,
  listTransactions,
  deleteTransaction,
  editTransaction,
  getTransaction,
  oddReferences,
  normalizeStoredReferences,
} from '../services/bankTransactions.js';
import { submitRequest } from '../services/changeRequests.js';
import { describeBankTxn } from '../lib/changeSummary.js';
import {
  classify,
  confirmMatch,
  unmatch,
  reconcileAccount,
  matchTxnToInvoices,
} from '../services/reconciliation.js';
import { requestSync, submitOtp, cancelSync, syncStatus } from '../services/bankSyncJobs.js';
import { syncBankAccount } from '../services/bankSync.js';
import { financyConfigured } from '../lib/financy.js';

const router = Router();

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('csv');


// A .xlsx is a ZIP archive — its first bytes are the local-file-header magic "PK\x03\x04".
// Detect by content (robust to a wrong/missing extension from a phone) or by name.
function looksLikeXlsx(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.xlsx')) return true;
  const b = file.buffer;
  return !!b && b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

async function accounts(scope = null) {
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  return getExecutor().many(
    `SELECT ba.*, c.name AS company_name, st.name AS store_name
       FROM bank_accounts ba JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
      WHERE 1 = 1${sc.sql} ORDER BY c.name, st.name`,
    [...sc.params],
  );
}

// Resolve the account to act on from body.account_id (form POST) or ?account= (GET), but ONLY if
// it is one the caller is authorized to see — a forged/foreign id falls back to the first
// authorized account, never acting cross-company. This is the single scope gate for account_id.
async function resolveAccountId(req) {
  const all = await accounts(req.scope);
  const requested = Number(req.body?.account_id) || Number(req.query.account);
  if (all.some((a) => a.id === requested)) return requested;
  // Nothing valid asked for: default to the ACTIVE store's account rather than the first one in
  // the list, so switching the active store actually changes what this page shows.
  const active = req.activeStoreId ? all.find((a) => Number(a.store_id) === Number(req.activeStoreId)) : null;
  return (active || all[0])?.id;
}

// אמצעי התשלום שחיוב בנק יכול להיות. צ׳ק אינו כאן: צ׳ק מותאם לפי מספרו במסלול הרגיל, ורישומו
// דרך המסלול הזה היה יוצר תשלום שני לאותו צ׳ק.
const PAY_METHODS = [
  { value: 'transfer', label: 'העברה בנקאית' },
  { value: 'standing_order', label: 'הוראת קבע' },
  { value: 'credit', label: 'כרטיס אשראי' },
];

// החשבוניות הפתוחות של החנות שמאחורי חשבון הבנק. הסקופ עובר גם כאן — הרשימה הזו נשלחת ל-UI,
// ולכן חשבונית מחוץ להרשאה לא תיראה בבורר מלכתחילה (הכתיבה נבדקת שוב בראוט עצמו).
async function payableForAccount(accountId, scope) {
  const acct = await getExecutor().one('SELECT store_id FROM bank_accounts WHERE id = ?', [accountId]);
  if (!acct) return [];
  const { listPayable } = await import('../services/invoices.js');
  const rows = await listPayable(scope);
  const out = [];
  for (const r of rows.filter((i) => Number(i.store_id) === Number(acct.store_id))) {
    // "כמה עוד פתוח" ולא הערך הנקוב: תשלום קודם כבר לקח את חלקו, וזה מה שהחיוב הזה יכול לסגור.
    const { invoiceAllocation } = await import('../services/allocations.js');
    const a = await invoiceAllocation(r.id);
    if (a.open === 0) continue;
    out.push({ ...r, open_amount: a.open });
  }
  return out;
}

async function renderPage(req, res, accountId, extra = {}) {
  const unmatched = accountId ? await listUnmatched(accountId) : [];
  const classified = await Promise.all(unmatched.map(async (t) => ({ txn: t, ...(await classify(t)) })));
  res.render('reconciliation/index', {
    title: 'התאמת בנק',
    accounts: await accounts(req.scope),
    accountId,
    purge: null,
    importsReady: await importsReady(),
    imports: accountId ? await listImports({ accountId }) : [],
    untracked: accountId ? await untrackedSummary(accountId) : null,
    oddRefs: accountId ? await oddReferences(accountId) : { count: 0, sample: [] },
    classified,
    transactions: accountId ? await listTransactions(accountId) : [],
    // חשבוניות פתוחות של החנות שמאחורי החשבון הזה — המועמדות לשיוך של חיוב שאין לו צ׳ק.
    // נשלחות פעם אחת עם הדף ומשרתות דיאלוג אחד משותף לכל השורות (ולא דיאלוג לכל שורה).
    payableInvoices: accountId ? await payableForAccount(accountId, req.scope) : [],
    // כרטיס סנכרון הבנק (סוכן מחשב המשרד) — רק למי שמורשה לייבא. המצב ההתחלתי מרונדר בשרת כדי
    // שהכרטיס יעבוד גם בלי JS; הסקריפט רק מרענן אותו בזמן אמת.
    bankSync: res.locals.can?.('import_bank') ? await syncStatus(req.user, req.scope) : null,
    payMethods: PAY_METHODS,
    // Open-Banking sync is offered only when the key is configured AND this account is linked.
    financyReady: financyConfigured(),
    financyLinked: Boolean(
      accountId && (await getExecutor().one('SELECT financy_account_id FROM bank_accounts WHERE id = ?', [accountId]))?.financy_account_id,
    ),
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    // ההודעה של PRG (ראה /match-invoices) חוזרת דרך ה-query, כדי שהפעולה תסתיים ב-GET.
    await renderPage(req, res, await resolveAccountId(req), {
      notice: req.query.notice ? String(req.query.notice).slice(0, 300) : null,
      error: req.query.err ? String(req.query.err).slice(0, 300) : null,
    });
  } catch (err) {
    next(err);
  }
});

// Statement import — CSV or Excel (.xlsx). Recognised bank columns:
// תאריך / חובה / זכות (or תאריך / סכום), plus אסמכתא and a description column.
router.post('/import-csv', requirePermission('import_bank'), (req, res, next) => {
  csvUpload(req, res, async (uploadErr) => {
    const accountId = await resolveAccountId(req);
    try {
      if (uploadErr) throw new RuleError('CSV', 'העלאת הקובץ נכשלה');
      if (!req.file) throw new RuleError('CSV', 'לא נבחר קובץ');
      let mapped;
      try {
        const rows = looksLikeXlsx(req.file)
          ? parseXlsx(req.file.buffer)
          : parseCsv(decodeBuffer(req.file.buffer));
        mapped = normalizeBankRows(rows);
      } catch (e) {
        throw new RuleError('CSV', e.message);
      }
      if (mapped.length === 0) throw new RuleError('CSV', 'לא נמצאו תנועות בקובץ');
      const fileName = decodeFileName(req.file.originalname);
      const { inserted, skipped } = await importTransactions(
        accountId, mapped, 'csv', req.user, undefined, { fileName },
      );
      const acct = await getExecutor().one('SELECT display_name FROM bank_accounts WHERE id = ?', [accountId]);
      // ההודעה אומרת **לאיזה חשבון** — הטעות שקרתה בפועל היא קובץ של חנות אחת שנחת בחשבון של אחרת,
      // ובלי לומר את זה בקול היא נראית בדיוק כמו הצלחה.
      return renderPage(req, res, accountId, {
        notice: `${fileName ? `"${fileName}" · ` : ''}יובאו ${inserted} תנועות חדשות ל${acct ? `חשבון ${acct.display_name}` : 'חשבון'}`
          + `${skipped ? `, ${skipped} כבר היו קיימות` : ''}. הקובץ נשמר ומוכן להתאמה.`,
      });
    } catch (err) {
      if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
      next(err);
    }
  });
});

// Open-Banking sync — pull this account's movements from Financy and run the matcher.
// Same permission as the CSV import: this is the same act (bring the statement in), automated.
// 🏦 סנכרון הבנק דרך סוכן מחשב המשרד (הפועלים לעסקים — קוד SMS בכל התחברות). האפליקציה לא
// מריצה דפדפן; היא רק כותבת בקשה, מציגה מצב, ומקבלת את הקוד שהמשתמש קיבל. ראה
// services/bankSyncJobs.js. תחת /reconciliation בכוונה: שומר הדף, חומת ברירת-המחדל וה-fallback
// של כתובות-פעולה כבר מכסים את הנתיבים האלה, בלי רשומה חדשה שאפשר לשכוח.
const wantsJson = (req) => /application\/json/i.test(req.get('accept') || '');

async function bankSyncReply(req, res, fn, okNotice) {
  try {
    await fn();
    if (wantsJson(req)) return res.json({ ok: true, ...(await syncStatus(req.user, req.scope)) });
    // PRG (ראה CLAUDE.md): הפניה ולא רינדור, כדי שרענון לא ישלח שוב בקשה או קוד.
    return res.redirect(303, `/reconciliation?notice=${encodeURIComponent(okNotice)}#bank-sync`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof NotFoundError) {
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: err.message });
      return res.redirect(303, `/reconciliation?err=${encodeURIComponent(err.message)}#bank-sync`);
    }
    throw err;
  }
}

router.get('/bank-sync/status', requirePermission('import_bank'), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, ...(await syncStatus(req.user, req.scope)) });
  } catch (err) {
    next(err);
  }
});

router.post('/bank-sync/request', requirePermission('import_bank'), async (req, res, next) => {
  try {
    await bankSyncReply(req, res, () => requestSync(req.user), 'בקשת הסנכרון נשלחה למחשב המשרד.');
  } catch (err) {
    next(err);
  }
});

router.post('/bank-sync/:id/otp', requirePermission('import_bank'), async (req, res, next) => {
  try {
    await bankSyncReply(req, res, () => submitOtp(req.params.id, req.body?.otp, req.user), 'הקוד נשלח — מאמת מול הבנק.');
  } catch (err) {
    next(err);
  }
});

router.post('/bank-sync/:id/cancel', requirePermission('import_bank'), async (req, res, next) => {
  try {
    await bankSyncReply(req, res, () => cancelSync(req.params.id, req.user), 'הסנכרון בוטל.');
  } catch (err) {
    next(err);
  }
});

router.post('/sync', requirePermission('import_bank'), async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    if (!accountId) throw new RuleError('FINANCY', 'לא נבחר חשבון בנק');
    const r = await syncBankAccount(accountId, {}, req.user);
    return renderPage(req, res, accountId, {
      notice:
        `סונכרן מהבנק (${r.from} — ${r.to}): ${r.fetched} תנועות נמשכו, ${r.inserted} חדשות, ` +
        `${r.skipped} כבר היו קיימות, ${r.matched} הותאמו אוטומטית לתשלומים.`,
    });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

// Manual single transaction (signed shekels, debit negative).
router.post('/add', requirePermission('import_bank'), async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    await importTransactions(
      accountId,
      [
        {
          txnDate: req.body.txn_date,
          amount: toAgorot(req.body.amount),
          description: req.body.description || null,
          rawReference: req.body.reference || null,
        },
      ],
      'manual',
      req.user,
    );
    await renderPage(req, res, accountId, { notice: 'התנועה נוספה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/auto', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    // צ׳קים **וגם** הפקדות — אותו כפתור באותו שם בשני הדפים חייב לעשות אותו דבר.
    const r = await reconcileAccount(accountId, req.user);
    await renderPage(req, res, accountId, {
      notice: `הותאמו אוטומטית ${r.matched} צ׳קים · ${r.ambiguous} דורשים הכרעה · ${r.unmatched} ללא התאמה`
        + `${r.deposits ? ` · ${r.deposits} הפקדות הותאמו לפי מספר שקית.` : '.'}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/match', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    // Scope guard: the transaction and the payment must both belong to the caller's companies —
    // a forged txn_id/payment_id from another company is refused (404, existence not leaked).
    await assertInScope('bankTxn', Number(req.body.txn_id), req.scope);
    await assertInScope('payment', Number(req.body.payment_id), req.scope);
    await confirmMatch(Number(req.body.txn_id), Number(req.body.payment_id), req.user);
    await renderPage(req, res, accountId, { notice: 'הצ׳ק סומן כנפרע.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

// שיוך חיוב לחשבונית אחת או לכמה — חיוב שיצא מהבנק בלי צ׳ק (העברה / הוראת קבע / חיוב ישיר).
// יוצר תשלום אמיתי בסכום שיצא מהבנק ומקשר אליו את התנועה, ולכן "בטל התאמה" הקיים עובד עליו.
router.post('/match-invoices', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    const txnId = Number(req.body.txn_id);
    const invoiceIds = [].concat(req.body.invoice_ids || []).map(Number).filter(Boolean);
    // שני צדדי השיוך נבדקים: תנועה מזויפת מחברה אחרת, וגם חשבונית מחברה/חנות אחרת (404).
    await assertInScope('bankTxn', txnId, req.scope);
    for (const id of invoiceIds) await assertInScope('invoice', id, req.scope);
    const r = await matchTxnToInvoices(
      txnId,
      invoiceIds,
      { method: req.body.pay_method, reference: req.body.pay_reference },
      req.user,
    );
    const msg = r.stillOpen > 0
      ? `החיוב שויך ל-${invoiceIds.length} חשבוניות. נותרה יתרה פתוחה של ${fromAgorot(r.stillOpen)} ₪.`
      : `החיוב שויך ל-${invoiceIds.length} חשבוניות, והן נסגרו במלואן.`;
    // PRG (ראה CLAUDE.md): רינדור במקום היה משאיר את הדפדפן על כתובת שהיא POST בלבד, וריענון
    // או שחזור PWA היו שולחים אליה GET — עם הפעולה כבר מבוצעת. ההודעה נוסעת ב-query.
    return res.redirect(303, `/reconciliation?account=${accountId}&notice=${encodeURIComponent(msg)}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof NotFoundError) {
      return res.redirect(303, `/reconciliation?account=${accountId}&err=${encodeURIComponent(err.message)}`);
    }
    next(err);
  }
});

router.post('/txn/:id/edit', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  const id = Number(req.params.id);
  try {
    await assertInScope('bankTxn', id, req.scope);
    const fields = {
      txnDate: req.body.txn_date,
      amount: toAgorot(req.body.amount),
      description: req.body.description || null,
      rawReference: req.body.reference || null,
    };
    // Non-owners: queue the edit for approval.
    if (req.user.role !== 'owner') {
      const current = await getTransaction(id);
      await submitRequest(
        { action: 'bank_txn.edit', entityType: 'bank_transaction', entityId: id, payload: { id, fields }, summary: describeBankTxn(current, fields) },
        req.user,
      );
      return renderPage(req, res, accountId, { notice: 'בקשת העריכה נשלחה לאישור הבעלים.' });
    }
    await editTransaction(id, fields, req.user);
    await renderPage(req, res, accountId, { notice: 'התנועה עודכנה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/txn/:id/delete', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    await assertInScope('bankTxn', Number(req.params.id), req.scope);
    await deleteTransaction(Number(req.params.id), req.user);
    await renderPage(req, res, accountId, { notice: 'התנועה נמחקה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/unmatch', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    await assertInScope('bankTxn', Number(req.body.txn_id), req.scope);
    await unmatch(Number(req.body.txn_id), req.user);
    await renderPage(req, res, accountId, { notice: 'ההתאמה בוטלה, הצ׳ק חזר לסטטוס פתוח.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

// "ניקוי לפי קובץ" — הדרך לנקות קובץ שהועלה לחשבון הלא נכון לפני שמעקב הייבוא היה קיים.
// לשורות אין סימון קובץ ואי אפשר לברור ביניהן ביד; הקובץ עצמו הוא הסימן. מעלים אותו שוב,
// מוצאים את התנועות שהוא הביא, **מציגים מה יימחק**, ורק אז מוחקים.
router.post('/purge-preview', requirePermission('import_bank'), (req, res, next) => {
  csvUpload(req, res, async (uploadErr) => {
    const accountId = await resolveAccountId(req);
    try {
      if (uploadErr) throw new RuleError('CSV', 'העלאת הקובץ נכשלה');
      if (!req.file) throw new RuleError('CSV', 'לא נבחר קובץ');
      let mapped;
      try {
        const rows = looksLikeXlsx(req.file) ? parseXlsx(req.file.buffer) : parseCsv(decodeBuffer(req.file.buffer));
        mapped = normalizeBankRows(rows);
      } catch (e) {
        throw new RuleError('CSV', e.message);
      }
      if (!mapped.length) throw new RuleError('CSV', 'לא נמצאו תנועות בקובץ');
      const hit = await matchRowsToTransactions(accountId, mapped);
      return renderPage(req, res, accountId, {
        purge: {
          fileName: decodeFileName(req.file.originalname),
          fileRows: mapped.length,
          ids: hit.ids,
          matchedIds: hit.matched,
          matchedCount: hit.matched.length,
          rows: hit.rows.slice(0, 12),
          total: hit.rows.reduce((n, r) => n + Number(r.amount || 0), 0),
        },
      });
    } catch (err) {
      if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
      next(err);
    }
  });
});

// מחיקה מרובה — הדרך לנקות שורות זרות שקדמו למעקב הייבוא ואין להן קובץ לבטל.
router.post('/txns/delete', requirePermission('import_bank'), async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    const ids = [].concat(req.body.txn_ids || []).map(Number).filter(Boolean);
    const r = await deleteTransactions(ids, accountId, req.user, { releaseMatched: req.body.release === '1' });
    return renderPage(req, res, accountId, {
      notice: `נמחקו ${r.deleted} תנועות`
        + `${r.released ? `, ו-${r.released} התאמות שוחררו — הצ׳קים חזרו לרשימת הפתוחים.` : ''}`
        + `${r.skippedMatched ? `. ${r.skippedMatched} דולגו כי הן מותאמות לצ׳ק — בטל את ההתאמה קודם.` : (r.released ? '' : '.')}`,
    });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

// תיקון אסמכתאות שנשמרו בכתיב מדעי (`1.81732779E8` במקום `181732779`). זו פעולה קנונית —
// אותו מספר, כתיב קריא — ולכן היא לא נוגעת בסכומים, בתאריכים ובהתאמות קיימות. ייבוא חדש כבר
// שומר את הצורה הנכונה מלכתחילה (lib/numText.js), אז הכפתור נועד למה שכבר במסד.
router.post('/refs/normalize', requirePermission('import_bank'), async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    const r = await normalizeStoredReferences(accountId, req.user);
    return renderPage(req, res, accountId, {
      notice: r.fixed
        ? `${r.fixed} מספרי אסמכתא נכתבו מחדש בספרות. לחץ עכשיו "התאמה אוטומטית" — צ׳ק שלא נמצא קודם `
          + `לפי מספר האסמכתא עשוי להימצא עכשיו.`
        : 'לא נמצאו אסמכתאות שדורשות תיקון.',
    });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

// ביטול ייבוא — הדרך לתקן קובץ שהועלה לחשבון הלא נכון. שורות שכבר הותאמו לצ׳ק אינן נמחקות
// בשקט: השירות מסרב, מחזיר את מספרן, והמשתמש מאשר שוב (`release=1`) אחרי שראה אותו.
router.post('/imports/:id/delete', requirePermission('import_bank'), async (req, res, next) => {
  try {
    const imp = await getImport(Number(req.params.id));
    // מזהה מהבקשה: בלי זה אפשר היה למחוק ייבוא של חברה אחרת לפי ניחוש מספר.
    await assertInScope('bankAccount', Number(imp.bank_account_id), req.scope);
    const r = await deleteImport(imp.id, req.user, { releaseMatched: req.body.release === '1' });
    return renderPage(req, res, Number(imp.bank_account_id), {
      notice: `הייבוא בוטל: ${r.deleted} תנועות נמחקו${r.released ? `, ${r.released} התאמות שוחררו` : ''}.`,
    });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      const imp = await getImport(Number(req.params.id)).catch(() => null);
      return renderPage(req, res, imp ? Number(imp.bank_account_id) : await resolveAccountId(req), { error: err.message });
    }
    next(err);
  }
});

export default router;
