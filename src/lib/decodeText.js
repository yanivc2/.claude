// Decode a bank-export upload to a JS string, tolerating the encodings that
// Israeli banks and Hebrew Excel actually emit:
//   • UTF-8 (with or without a BOM)
//   • UTF-16 LE/BE (Excel "Unicode Text" saves)
//   • Windows-1255 (Hebrew ANSI — the historical default of Hebrew Windows/Excel)
//
// Reading a Windows-1255 file as UTF-8 turns every Hebrew header into mojibake,
// which is why a perfectly valid bank CSV would fail header detection and throw
// "שורה 2: חסר תאריך או סכום". Node 22 ships full ICU, so TextDecoder supports
// all of these natively — no external dependency needed.

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
export function decodeBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  // Byte-order marks are decisive when present.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  // No BOM: try strict UTF-8. Hebrew stored as Windows-1255 uses single high
  // bytes (0xE0–0xFA) that are not valid UTF-8 sequences, so a fatal decode
  // throws and we fall back to Windows-1255.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1255').decode(bytes);
    } catch {
      return bytes.toString('utf8'); // last resort — should be unreachable
    }
  }
}

/**
 * שם קובץ כפי שהמשתמש רואה אותו — לא כפי ש-multer מוסר אותו.
 *
 * multer מוסר את `originalname` כבייטים שנקראו כ-latin1, ולכן "פקדון ספטמבר.csv" מגיע כג'יבריש.
 * השם הזה נשמר במסד ואז מוצג בשורת הייבוא — בדיוק המקום שבו המשתמש אמור לזהות איזה קובץ הוא
 * העלה לחשבון הלא נכון.
 *
 * 🔴 הפונקציה בטוחה לקריאה חוזרת, ולכן אפשר להפעיל אותה גם על שם שכבר נשמר במסד: שם עברי תקין
 * מכיל תווים מעל U+00FF ומוחזר כמות שהוא; רק מחרוזת שכולה בייטים (\u0000-\u00ff) נבחנת, ורק אם
 * הפענוח שלה כ-UTF-8 לא יצר תו החלפה.
 *
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
export function decodeFileName(name) {
  const raw = (name ?? '').toString();
  if (!raw) return null;
  if (/[^\u0000-\u00ff]/.test(raw)) return raw; // כבר טקסט תקין, לא בייטים
  try {
    const back = Buffer.from(raw, 'latin1').toString('utf8');
    return back.includes('\uFFFD') ? raw : back;
  } catch {
    return raw;
  }
}
