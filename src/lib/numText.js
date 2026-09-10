// טקסט של מספר — כפי שקובץ בנק כותב אותו, לא כפי שהוא נראה יפה.
//
// היצואן של דף הבנק כותב את המספרים כפי ש-Java מדפיסה double: אסמכתא 181732779 יוצאת
// `1.81732779E8`, ואסמכתא 26411 יוצאת `26411.0`. שני אלה נכנסו למסד כמו שהם והופיעו
// למשתמש בעמודת "אסמכתא" — מספר שאי אפשר להשוות לצ׳ק, לשקית הפקדה או לעין אנושית.
//
// 🔴 ההרחבה כאן היא **טקסטואלית ולא דרך Number**: `String(Number('9.007199254740993E15'))`
// כבר מאבד ספרה, ואסמכתא בת 16 ספרה היא דבר קיים. הספרות מוזזות כמחרוזת, ולכן כל ספרה
// שהייתה בקובץ נשארת בדיוק כפי שהייתה.

/**
 * מרחיב כתיב מדעי ומוריד שבר-אפסים מיותר. כל דבר שאינו מספר שלם-בכתיבתו מוחזר כמות שהוא
 * (כולל '1,234' , 'צ׳ק 55' או '' ) — הפונקציה מתקנת כתיב, לא מנקה טקסט.
 * @param {unknown} raw
 * @returns {string}
 */
export function plainNumber(raw) {
  const s = String(raw ?? '').trim();
  const m = /^([-+]?)(\d+)(?:\.(\d*))?[eE]([-+]?\d+)$/.exec(s);
  if (m) {
    const [, rawSign, ip, fp = '', ex] = m;
    const sign = rawSign === '+' ? '' : rawSign;
    const e = Number(ex);
    let digits = ip + fp;
    let point = ip.length + e;          // מיקום הנקודה אחרי ההזזה
    if (point <= 0) {                    // 1.5E-3 -> 0.0015
      digits = '0'.repeat(1 - point) + digits;
      point = 1;
    }
    if (point >= digits.length) digits += '0'.repeat(point - digits.length);
    const head = digits.slice(0, point).replace(/^0+(?=\d)/, '');
    const tail = digits.slice(point).replace(/0+$/, '');
    return sign + (tail ? `${head}.${tail}` : head);
  }
  const t = /^([-+]?\d+)\.0+$/.exec(s);  // 26411.0 -> 26411
  return t ? t[1].replace(/^\+/, '') : s;
}

/** האם המחרוזת הזו נשמרה בכתיב שלא ניתן לקריאה (כתיב מדעי / שבר-אפסים)? */
export function isOddNumberText(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  return /^[-+]?\d+(\.\d*)?[eE][-+]?\d+$/.test(s) || /^[-+]?\d+\.0+$/.test(s);
}
