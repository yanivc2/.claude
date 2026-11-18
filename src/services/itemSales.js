// 🛒 מכר פריטים במעקב (ג'חנון, פרחים) מדוח "מכר יומי" של הקופה — שמירה, והחישוב שמוצג ליד הוצאת מזומן.
// בעלים 17/11: "בפינק כשיש הוצאות של ג'חנון או של פרחים אני רוצה שיופיע חישוב של מכר מימים שישי שבת
// וראשון שלפני ההוצאה (אם ההוצאה נרשמה ביום ראשון אז להכליל גם את היום ראשון הזה)"; המקום: "לייד הסכום
// שנרשם כהוצאת מזומן". הנתונים מגיעים מהמייל (POST /ingest/item-sales, סקריפט הג'ימייל).
import { getExecutor, tx } from '../db/adapter.js';
import { TRACKED_GROUPS, groupOfExpense, weekendBefore } from '../lib/trackedItems.js';

let ready = null;
/** 🔴 probe: לפני "עדכן מסד נתונים" אין טבלאות — ואז לא מציגים כלום (ולא "חסר דוח" שקרי). */
export async function itemSalesReady(x = getExecutor()) {
  if (ready) return true;
  try {
    await x.one('SELECT id FROM pos_item_reports LIMIT 1', []);
    await x.one('SELECT id FROM pos_item_sales LIMIT 1', []);
    ready = true;
    return true;
  } catch {
    return false;
  }
}

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/**
 * שמירת דוח של יום אחד. קליטה חוזרת של אותו יום מחליפה אותו (אידמפוטנטי) — השורות של היום נמחקות
 * ונכתבות מחדש; אף טבלה לא מצביעה עליהן.
 * @param {number} storeId
 * @param {{date:string, totalSales:number|null, tracked:Array<{group,code,name,qty,sales}>}} parsed
 * @returns {Promise<{date:string, replaced:boolean, groups:Object<string,{qty:number,sales:number}>}>}
 */
export async function importItemSales(storeId, parsed, fileName = null, x = getExecutor()) {
  if (!(await itemSalesReady(x))) {
    const e = new Error('item sales tables missing — run "עדכן מסד נתונים"');
    e.code = 'SCHEMA';
    throw e;
  }
  const date = parsed.date;
  const byCode = new Map();
  for (const t of parsed.tracked || []) {
    const cur = byCode.get(t.code) || { ...t, qty: 0, sales: 0 };
    cur.qty += Number(t.qty) || 0;
    cur.sales += Number(t.sales) || 0;
    byCode.set(t.code, cur);
  }
  let replaced = false;
  await tx(async (t) => {
    const had = await t.one('SELECT id FROM pos_item_reports WHERE store_id = ? AND report_date = ?', [storeId, date]);
    if (had) {
      replaced = true;
      await t.run('UPDATE pos_item_reports SET file_name = ?, total_sales = ?, imported_at = ? WHERE id = ?',
        [fileName, parsed.totalSales ?? null, stamp(), had.id]);
    } else {
      await t.run('INSERT INTO pos_item_reports (store_id, report_date, file_name, total_sales, imported_at) VALUES (?, ?, ?, ?, ?)',
        [storeId, date, fileName, parsed.totalSales ?? null, stamp()]);
    }
    await t.run('DELETE FROM pos_item_sales WHERE store_id = ? AND sale_date = ?', [storeId, date]);
    for (const it of byCode.values()) {
      await t.run(
        'INSERT INTO pos_item_sales (store_id, sale_date, item_group, item_code, item_name, qty, sales) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [storeId, date, it.group, it.code, it.name || null, it.qty, it.sales],
      );
    }
  });
  const groups = {};
  for (const it of byCode.values()) {
    const g = groups[it.group] || (groups[it.group] = { qty: 0, sales: 0 });
    g.qty += it.qty;
    g.sales += it.sales;
  }
  return { date, replaced, groups };
}

const DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * מצרף לכל הוצאת מזומן שמדברת על ג'חנון / פרחים את מכר שישי+שבת+ראשון שלפניה, מחנות ההוצאה:
 * `row.itemSales = {group, label, icon, range, qty, sales, days:[{date, label, qty, sales, missing}], missing:[date]}`.
 * רק לחנות שכבר הגיע ממנה לפחות דוח "מכר יומי" אחד — לחנות שלא שולחת את הדוח אין מה להראות, ו"חסר"
 * על כל שורה שלה היה רעש. יום בלי דוח = `missing` (נאמר בקול), יום עם דוח ובלי מכר = 0.
 * שתי שאילתות לכל הרשימה, לא לכל שורה.
 */
export async function withItemSales(rows, x = getExecutor()) {
  const list = rows || [];
  const wants = [];
  for (const r of list) {
    const g = r && r.store_id && r.expense_date ? groupOfExpense(r) : null;
    const w = g ? weekendBefore(r.expense_date) : null;
    if (g && w) wants.push({ r, g, w });
  }
  if (!wants.length || !(await itemSalesReady(x))) return list;
  const stores = [...new Set(wants.map((o) => Number(o.r.store_id)))];
  const marks = stores.map(() => '?').join(',');
  const lo = wants.reduce((m, o) => (o.w.fri < m ? o.w.fri : m), wants[0].w.fri);
  const hi = wants.reduce((m, o) => (o.w.sun > m ? o.w.sun : m), wants[0].w.sun);
  const reports = await x.many(`SELECT store_id, report_date FROM pos_item_reports WHERE store_id IN (${marks})`, stores);
  const hasAny = new Set(reports.map((r) => Number(r.store_id)));
  const got = new Set(reports.map((r) => `${Number(r.store_id)}|${r.report_date}`));
  const sales = await x.many(
    `SELECT store_id, sale_date, item_group, SUM(qty) AS qty, SUM(sales) AS sales FROM pos_item_sales
      WHERE store_id IN (${marks}) AND sale_date >= ? AND sale_date <= ?
      GROUP BY store_id, sale_date, item_group`,
    [...stores, lo, hi],
  );
  const by = new Map(sales.map((s) => [`${Number(s.store_id)}|${s.sale_date}|${s.item_group}`, s]));
  for (const { r, g, w } of wants) {
    const sid = Number(r.store_id);
    if (!hasAny.has(sid)) continue;
    const days = w.days.map((d) => {
      const s = by.get(`${sid}|${d}|${g.key}`);
      const missing = !got.has(`${sid}|${d}`);
      return {
        date: d,
        label: `${DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${dm(d)}`,
        qty: missing ? 0 : Number(s?.qty || 0),
        sales: missing ? 0 : Number(s?.sales || 0),
        missing,
      };
    });
    r.itemSales = {
      group: g.key,
      label: g.label,
      icon: g.icon,
      range: `שישי–ראשון ${dm(w.fri)}–${dm(w.sun)}`,
      from: dm(w.fri),
      to: dm(w.sun),
      qty: days.reduce((n, d) => n + d.qty, 0),
      sales: days.reduce((n, d) => n + d.sales, 0),
      days,
      missing: days.filter((d) => d.missing).map((d) => d.date),
    };
  }
  return list;
}

export { TRACKED_GROUPS };
