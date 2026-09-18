import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeClause, scopeWhere } from '../lib/scope.js';
import { addDaysIso } from '../lib/loginHours.js';
import { logAction } from './audit.js';

// "הצהרה על הפקדה" — a bank deposit declaration: a bag number + amount for a store, with a flag
// recording whether it was actually deposited to the bank. Optionally linked to the Z report it
// was declared on (z_report_id) and, after bank reconciliation, to a bank line (bag=reference).

export async function createDeposit(
  { storeId, zReportId = null, depositDate, bagNumber = null, amount = 0, deposited = false },
  actor,
  x = getExecutor(),
) {
  if (!storeId) throw new RuleError('VALIDATION', 'חנות חובה');
  if (!depositDate) throw new RuleError('VALIDATION', 'תאריך הפקדה חובה');
  const info = await x.run(
    'INSERT INTO deposits (store_id, z_report_id, deposit_date, bag_number, amount, deposited, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Number(storeId), zReportId ? Number(zReportId) : null, depositDate, (bagNumber && String(bagNumber).trim()) || null, amount, deposited ? 1 : 0, actor.id],
  );
  await logAction(
    { userId: actor.id, action: 'deposit.create', entityType: 'deposit', entityId: info.lastInsertRowid, details: { amount, deposited: !!deposited } },
    x,
  );
  return info.lastInsertRowid;
}

// Common SELECT: deposit + store/company names + the linked Z number (for "שיוך ל-Z").
const DEPOSIT_SELECT = `SELECT d.*, st.name AS store_name, c.name AS company_name, z.z_number
                  FROM deposits d
                  JOIN stores st ON st.id = d.store_id
                  JOIN companies c ON c.id = st.company_id
                  LEFT JOIN z_reports z ON z.id = d.z_report_id`;

export async function listDeposits({ storeId = null, scope = null, limit = 30 } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 'st.id');
  const params = [...sc.params];
  let sql = `${DEPOSIT_SELECT} WHERE 1 = 1${sc.sql}`;
  if (storeId) { sql += ' AND d.store_id = ?'; params.push(storeId); }
  sql += ' ORDER BY d.deposit_date DESC, d.id DESC LIMIT ?';
  params.push(limit);
  return x.many(sql, params);
}

/**
 * "אימות ספירה" — האם הבנק אישר בסוף את הסכום שהוצהר, או תיקן אותו.
 *
 * מה קורה בפועל: השקית מגיעה לסניף, הבנק מזכה את החשבון בסכום שהוצהר, וההפקדה נראית סגורה.
 * ואז — יום אחר כך, ואחרי סוף שבוע או חג כמה ימים — הסניף סופר את השקית וכותב שורות **"תיקון"**
 * באותה אסמכתה: ביטול הזיכוי המקורי וזיכוי מחדש בסכום שנספר בפועל. ההפרש ביניהן הוא מה שבאמת
 * נכנס או חסר.
 *
 * 🔴 ההפרש הוא **סכום שורות התיקון**, לא הפרש מול הזיכוי המקורי. הבנק כותב אותן כזוג
 * (−68,230 ואז +68,220), וסכומן הוא ההפרש הנקי (−10). חיסור מול השורה המקורית היה סופר את
 * הביטול פעמיים.
 *
 * 🔴 "אומתה" נאמר רק כשיש כיסוי בנתונים. אם דף הבנק שיובא אינו מגיע עד שבוע אחרי ההפקדה, אי
 * אפשר לדעת שלא הגיע תיקון — רק שעוד לא ראינו אותו. אמירת "אומתה" במצב הזה היא אישור שקרי על
 * כסף, ולכן המצב הזה נקרא "ממתין" ואומר עד מתי.
 *
 * @param {Array} deposits שורות מ-listDeposits
 * @returns {Promise<Map<number, {statusDate, correctionTotal, verifyDate, state, corrections}>>}
 */
export const VERIFY_WINDOW_DAYS = 7;

export async function depositVerifications(deposits, x = getExecutor()) {
  const out = new Map();
  const matched = (deposits || []).filter((d) => d.matched_txn_id);
  if (!matched.length) return out;

  // שורת הבנק של כל הפקדה — ממנה מגיעים תאריך הסטטוס, החשבון והאסמכתה.
  const txns = await x.many(
    'SELECT id, bank_account_id, txn_date, amount, raw_reference, description FROM bank_transactions', [],
  );
  const byId = new Map(txns.map((t) => [Number(t.id), t]));
  // כל התנועות באותו חשבון ואותה אסמכתה — סינון ב-JS, כי זו רשימה קצרה וכדי לא להסתבך עם pg-mem.
  const byKey = new Map();
  for (const t of txns) {
    const ref = String(t.raw_reference ?? '').trim();
    if (!ref) continue;
    const k = `${Number(t.bank_account_id)}|${ref}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  // עד איזה תאריך יש בכלל נתוני בנק לכל חשבון — זה מה שמבדיל "אומתה" מ"עוד לא ראינו".
  const lastSeen = new Map();
  for (const t of txns) {
    const k = Number(t.bank_account_id);
    const d = String(t.txn_date || '');
    if (!lastSeen.has(k) || d > lastSeen.get(k)) lastSeen.set(k, d);
  }

  for (const dep of matched) {
    const base = byId.get(Number(dep.matched_txn_id));
    if (!base) continue;
    const ref = String(base.raw_reference ?? '').trim();
    const statusDate = base.txn_date || null;
    const siblings = (byKey.get(`${Number(base.bank_account_id)}|${ref}`) || [])
      // 🔴 השורה המקורית עצמה יוצאת מהחישוב: היא הזיכוי, לא התיקון.
      .filter((t) => Number(t.id) !== Number(base.id))
      .filter((t) => !statusDate || String(t.txn_date || '') >= String(statusDate))
      .sort((a, b) => String(a.txn_date).localeCompare(String(b.txn_date)) || Number(a.id) - Number(b.id));

    const correctionTotal = siblings.reduce((n, t) => n + (Number(t.amount) || 0), 0);
    const verifyDate = siblings.length ? siblings[siblings.length - 1].txn_date : null;
    const deadline = statusDate ? addDaysIso(statusDate, VERIFY_WINDOW_DAYS) : null;
    const covered = statusDate && (lastSeen.get(Number(base.bank_account_id)) || '') >= deadline;

    out.set(Number(dep.id), {
      statusDate,
      corrections: siblings,
      correctionTotal: siblings.length ? correctionTotal : null,
      verifyDate,
      deadline,
      state: siblings.length ? 'corrected' : (covered ? 'verified' : 'waiting'),
    });
  }
  return out;
}

/**
 * Create-or-update the deposit declaration linked to a Z report (used by the Z edit form).
 * With nothing declared (no bag and no amount) it's a no-op. Preserves any bank-reconciliation
 * fields on an existing row (only bag/amount/deposited/date are touched).
 */

/**
 * כל שקיות ההפקדה של דוח Z, לפי סדר הזנתן.
 *
 * הפקדה אחת יכולה להתפצל לכמה שקיות — לפעמים פשוט אין מקום בשקית אחת. הטבלה תמכה בזה מאז ומתמיד
 * (אין UNIQUE על z_report_id); מה שלא תמך זה הטופס, שהכיר שקית אחת בלבד.
 */
export async function depositsForZ(zReportId, x = getExecutor()) {
  return x.many('SELECT * FROM deposits WHERE z_report_id = ? ORDER BY id', [Number(zReportId)]);
}

/**
 * מחליף את שקיות ההפקדה של דוח Z במה שהטופס שלח. מקביל ל-`replaceExpenses`, עם הבדל אחד מהותי:
 *
 * 🔴 **שורה שכבר הותאמה לתנועת בנק אינה נמחקת.** `matched_txn_id` הוא עובדה שקרתה — הבנק דיווח על
 * ההפקדה הזו — ומחיקה שלה כאן הייתה מוחקת גם את ההתאמה ואת `recon_diff`, ומחזירה את התנועה למצב
 * "לא מותאמת" בלי שאיש התכוון. לכן שורות מזוהות ב-id ומעודכנות במקום, ולא נמחקות-ונוצרות מחדש.
 *
 * @param {Array<{id?: number|null, bagNumber?: string|null, amount?: number, deposited?: boolean}>} rows
 * @returns {Promise<{kept:number, created:number, removed:number, locked:number}>}
 */
export async function replaceDepositsForZ(zReportId, rows, { storeId, depositDate }, actor, x = getExecutor()) {
  const zid = Number(zReportId);
  const existing = await depositsForZ(zid, x);
  const byId = new Map(existing.map((d) => [Number(d.id), d]));

  const clean = (rows || [])
    .map((r) => ({
      id: Number(r.id) || null,
      bag: (r.bagNumber ?? '').toString().trim() || null,
      amount: Math.round(Number(r.amount) || 0),
      deposited: !!r.deposited,
    }))
    // שורה ריקה לגמרי היא פשוט שורה שלא מולאה — לא הצהרה, ולא שגיאה.
    .filter((r) => r.bag || r.amount || r.id);

  let kept = 0; let created = 0; let removed = 0; let locked = 0;
  const seen = new Set();

  for (const r of clean) {
    const hit = r.id ? byId.get(r.id) : null;
    if (hit) {
      seen.add(Number(hit.id));
      // שורה קיימת שרוקנה = בקשה למחוק אותה, ונטפל בה יחד עם השאר למטה.
      if (!r.bag && !r.amount) continue;
      await x.run(
        'UPDATE deposits SET store_id = ?, deposit_date = ?, bag_number = ?, amount = ?, deposited = ? WHERE id = ?',
        [Number(storeId), depositDate, r.bag, r.amount, r.deposited ? 1 : 0, hit.id],
      );
      kept += 1;
      await logAction({ userId: actor.id, action: 'deposit.update', entityType: 'deposit', entityId: hit.id, details: { amount: r.amount } }, x);
    } else if (r.bag || r.amount) {
      await createDeposit(
        { storeId, zReportId: zid, depositDate, bagNumber: r.bag, amount: r.amount, deposited: r.deposited },
        actor, x,
      );
      created += 1;
    }
  }

  for (const d of existing) {
    const stillThere = clean.some((r) => r.id === Number(d.id) && (r.bag || r.amount));
    if (stillThere) continue;
    if (d.matched_txn_id) { locked += 1; continue; } // הותאמה בבנק — לא נוגעים
    await x.run('DELETE FROM deposits WHERE id = ?', [d.id]);
    await logAction({ userId: actor.id, action: 'deposit.delete', entityType: 'deposit', entityId: d.id }, x);
    removed += 1;
  }
  return { kept, created, removed, locked };
}

/** The (first) deposit declaration linked to a Z report, or null. */
export async function depositForZ(zReportId, x = getExecutor()) {
  return x.one('SELECT * FROM deposits WHERE z_report_id = ? ORDER BY id LIMIT 1', [zReportId]);
}

/** Total declared deposit (agorot) linked to a given Z report. */
export async function depositTotalForZ(zReportId, x = getExecutor()) {
  const row = await x.one('SELECT COALESCE(SUM(amount),0) AS s FROM deposits WHERE z_report_id = ?', [zReportId]);
  return Number(row.s) || 0;
}

export async function setDeposited(id, deposited, actor, x = getExecutor()) {
  const row = await x.one('SELECT id FROM deposits WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`הפקדה ${id} לא נמצאה`);
  await x.run('UPDATE deposits SET deposited = ? WHERE id = ?', [deposited ? 1 : 0, id]);
  await logAction({ userId: actor.id, action: 'deposit.mark', entityType: 'deposit', entityId: id, details: { deposited: !!deposited } }, x);
}

/** Set the bag number on a deposit (used by the barcode scanner before marking it deposited). */
export async function setDepositBag(id, bagNumber, actor, x = getExecutor()) {
  const bag = (bagNumber && String(bagNumber).trim()) || null;
  await x.run('UPDATE deposits SET bag_number = ? WHERE id = ?', [bag, id]);
  await logAction({ userId: actor.id, action: 'deposit.bag', entityType: 'deposit', entityId: id, details: { bagNumber: bag } }, x);
}

/**
 * Lifecycle status of a deposit declaration, derived from existing columns (no schema change):
 *   • matched_txn_id set → 'matched'   (הותאמה בבנק)
 *   • deposited = 1      → 'deposited' (הופקדה)
 *   • otherwise          → 'declared'  (הונפקה)
 */
export function depositStatus(d) {
  if (!d) return null;
  if (d.matched_txn_id != null) return { key: 'matched', label: 'הותאמה בבנק', badge: 'b-cleared' };
  if (Number(d.deposited) === 1) return { key: 'deposited', label: 'הופקדה', badge: 'b-approved' };
  return { key: 'declared', label: 'הונפקה', badge: 'b-on_hold' };
}

/** Deposits that were declared but not yet marked deposited (deposited = 0). Newest first. */
export async function declaredNotDeposited({ scope = null, storeId = null } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 'st.id');
  const params = [...sc.params];
  let sql = `${DEPOSIT_SELECT} WHERE d.deposited = 0${sc.sql}`;
  if (storeId) { sql += ' AND d.store_id = ?'; params.push(storeId); }
  sql += ' ORDER BY d.deposit_date DESC, d.id DESC';
  return x.many(sql, params);
}

/** Z reports that have no deposit declaration linked to them yet. Newest first. */
export async function zReportsWithoutDeposit({ scope = null, storeId = null } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 'st.id');
  const params = [...sc.params];
  // NOT IN (non-correlated) keeps pg-mem happy — it rejects correlated subqueries / anti-joins.
  let sql = `SELECT z.id, z.z_number, z.z_date, z.store_id, st.name AS store_name, c.name AS company_name
               FROM z_reports z
               JOIN stores st ON st.id = z.store_id
               JOIN companies c ON c.id = st.company_id
              WHERE z.id NOT IN (SELECT z_report_id FROM deposits WHERE z_report_id IS NOT NULL)${sc.sql}`;
  if (storeId) { sql += ' AND z.store_id = ?'; params.push(storeId); }
  sql += ' ORDER BY z.z_date DESC, z.id DESC';
  return x.many(sql, params);
}

export async function deleteDeposit(id, actor, x = getExecutor()) {
  await x.run('DELETE FROM deposits WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'deposit.delete', entityType: 'deposit', entityId: id }, x);
}
