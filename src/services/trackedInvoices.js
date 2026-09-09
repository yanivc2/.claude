// "חשבוניות מעוקבות לתשלום" — חשבוניות שמחכות לטיפול של הספק לפני שסוגרים אותן: זיכוי שהובטח,
// כמות שלא סופקה, מסמך חסר, מחיר שגוי.
//
// למה דגל נפרד ולא ערך ב-`invoices.status`:
//   • `on_hold` **מנוהל אוטומטית** — `updateInvoice` מדליק ומכבה אותו לפי R3 בכל עריכה, ושיוך
//     תשלום מנקה אותו. עיקוב שהיה יושב שם היה נמחק בשקט ברגע שמישהו מתקן שדה בחשבונית.
//   • עיקוב הוא **תזכורת מול הספק**, לא חסימה טכנית. חשבונית יכולה להיות מאושרת לתשלום, ואפילו
//     משולמת, ועדיין לחכות לזיכוי — ואת זה `status` לא יודע לבטא.
// לכן הדגל נדלק ונכבה רק בידיים, ושחרור מעיקוב מוציא את החשבונית מהדף הזה ותו לא.
import { getExecutor, nowTs } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeWhere } from '../lib/scope.js';
import { fromAgorot } from '../lib/money.js';
import { logAction } from './audit.js';

/** האם הסכימה עודכנה? (הבעלים מריץ את העדכון ידנית — כמו ב-voidedChecks.js.) */
export async function trackedReady(x = getExecutor()) {
  try {
    await x.many('SELECT tracked_for_payment FROM invoices LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

const clean = (v) => (v ?? '').toString().trim() || null;

async function getInvoiceRow(id, x) {
  const row = await x.one('SELECT * FROM invoices WHERE id = ?', [Number(id)]);
  if (!row) throw new NotFoundError(`חשבונית ${id} לא נמצאה`);
  return row;
}

/**
 * סימון חשבונית כמעוקבת לתשלום. אידמפוטנטי — סימון חוזר רק מעדכן את ההערה.
 * @param {{note?: string}} input
 */
export async function trackInvoice(id, { note = null } = {}, actor, x = getExecutor()) {
  const inv = await getInvoiceRow(id, x);
  const already = Number(inv.tracked_for_payment) === 1;
  await x.run(
    'UPDATE invoices SET tracked_for_payment = 1, tracked_note = ?, tracked_at = ?, tracked_by = ? WHERE id = ?',
    [note === null && already ? inv.tracked_note : clean(note), already ? inv.tracked_at : nowTs(), actor?.id ?? null, inv.id],
  );
  await logAction(
    { userId: actor?.id ?? null, action: already ? 'invoice.track_update' : 'invoice.track', entityType: 'invoice', entityId: inv.id },
    x,
  );
  return getInvoiceRow(id, x);
}

/** שחרור מעיקוב. ההערה נשמרת — היא התיעוד של מה שנדרש, גם אחרי שהסתיים. */
export async function releaseInvoice(id, actor, x = getExecutor()) {
  const inv = await getInvoiceRow(id, x);
  if (Number(inv.tracked_for_payment) !== 1) throw new RuleError('R', 'החשבונית אינה מעוקבת');
  await x.run('UPDATE invoices SET tracked_for_payment = 0 WHERE id = ?', [inv.id]);
  await logAction({ userId: actor?.id ?? null, action: 'invoice.track_release', entityType: 'invoice', entityId: inv.id }, x);
  return getInvoiceRow(id, x);
}

/** עדכון ההסבר/פירוט בלבד. */
export async function setTrackedNote(id, note, actor, x = getExecutor()) {
  const inv = await getInvoiceRow(id, x);
  await x.run('UPDATE invoices SET tracked_note = ? WHERE id = ?', [clean(note), inv.id]);
  await logAction({ userId: actor?.id ?? null, action: 'invoice.track_note', entityType: 'invoice', entityId: inv.id }, x);
  return getInvoiceRow(id, x);
}

export const isTracked = (inv) => Number(inv?.tracked_for_payment) === 1;

/** התווית שמוצגת בעמודת הסטטוס. */
export function trackedStatusLabel(inv) {
  if (isTracked(inv)) return { label: 'מעוקבת לתשלום', badge: 'b-tracked' };
  const s = inv?.status;
  if (s === 'paid') return { label: 'שולמה', badge: 'b-paid' };
  if (s === 'approved_for_payment') return { label: 'מאושרת לתשלום', badge: 'b-approved' };
  if (s === 'on_hold') return { label: 'מוחזקת', badge: 'b-blocked' };
  return { label: 'נרשמה', badge: 'b-neutral' };
}

/**
 * החשבוניות המעוקבות, מסוננות. הסינון כאן הוא של **צמצום הרשימה** ולא של הרשאה — הסקופ נאכף
 * תמיד דרך `scopeWhere`, בין אם המשתמש סינן ובין אם לא.
 *
 * @param {{supplier?, number?, amount?, from?, to?}} filters
 */
export async function listTracked({ scope = null, filters = {} } = {}, x = getExecutor()) {
  if (!(await trackedReady(x))) return [];
  const sc = scopeWhere(scope, 'i.company_id', 'i.store_id');
  const params = [...sc.params];
  let where = '';

  const supplier = clean(filters.supplier);
  if (supplier) { where += ' AND LOWER(s.name) LIKE ?'; params.push(`%${supplier.toLowerCase()}%`); }
  const number = clean(filters.number);
  if (number) { where += ' AND LOWER(i.invoice_number) LIKE ?'; params.push(`%${number.toLowerCase()}%`); }
  // סכום: התאמה מדויקת לאגורות, כי "5,000" ו-"5000.00" הם אותו סכום ומי שמחפש סכום יודע אותו.
  const amount = filters.amount != null && String(filters.amount).trim() !== '' ? Number(filters.amount) : null;
  if (amount != null && Number.isFinite(amount)) { where += ' AND i.total_amount = ?'; params.push(Math.round(amount * 100)); }
  const from = clean(filters.from);
  if (from) { where += ' AND i.invoice_date >= ?'; params.push(from); }
  const to = clean(filters.to);
  if (to) { where += ' AND i.invoice_date <= ?'; params.push(to); }

  return x.many(
    `SELECT i.*, s.name AS supplier_name, s.phone AS supplier_phone, s.email AS supplier_email,
            s.contact_phone AS supplier_contact_phone, st.name AS store_name, u.name AS tracked_by_name
       FROM invoices i
       LEFT JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN stores st ON st.id = i.store_id
       LEFT JOIN users u ON u.id = i.tracked_by
      WHERE i.tracked_for_payment = 1${sc.sql}${where}
      ORDER BY i.invoice_date DESC, i.id DESC`,
    params,
  );
}

/**
 * ההודעה לספק, **נגזרת ממה שהוזן** ולא מוקלדת מחדש: מי הספק, איזו חשבונית, מאיזה תאריך, על כמה,
 * ומה נדרש (`tracked_note`). בלי הערה ההודעה עדיין שלמה ומבקשת בירור — עדיף על הודעה ריקה.
 */
export function trackedMessage(inv) {
  const money = (a) => `${fromAgorot(Number(a) || 0).toLocaleString('he-IL', { minimumFractionDigits: 2 })} ₪`;
  const hello = inv.supplier_name ? `שלום ${inv.supplier_name},` : 'שלום,';
  const lines = [
    hello,
    '',
    `בנוגע לחשבונית מספר ${inv.invoice_number}${inv.invoice_date ? ` מתאריך ${inv.invoice_date}` : ''}`
      + `${inv.total_amount ? `, על סך ${money(inv.total_amount)}` : ''}:`,
  ];
  if (inv.tracked_note) lines.push('', inv.tracked_note);
  else lines.push('', 'החשבונית מעוכבת לתשלום עד להשלמת טיפול מצדכם.');
  lines.push('', 'נודה לחזרתכם בהקדם.');
  return lines.join('\n');
}

/** מספר ישראלי → פורמט בינלאומי ל-wa.me. בלי מספר, וואטסאפ פותח בחירת איש קשר. */
export function waPhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('972')) return p;
  return p.startsWith('0') ? `972${p.slice(1)}` : `972${p}`;
}

export function whatsappLink(inv) {
  const phone = waPhone(inv.supplier_phone || inv.supplier_contact_phone);
  return `https://wa.me/${phone}?text=${encodeURIComponent(trackedMessage(inv))}`;
}

export function mailtoLink(inv) {
  const subject = `חשבונית ${inv.invoice_number}${inv.supplier_name ? ` — ${inv.supplier_name}` : ''}`;
  const to = inv.supplier_email || '';
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(trackedMessage(inv))}`;
}
