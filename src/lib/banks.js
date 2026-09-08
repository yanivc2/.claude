// קודי הבנקים בישראל, ואימות של פרטי חשבון להעברה.
//
// למה רשימה ולא טקסט חופשי: העברה בנקאית מזוהה לפי **קוד הבנק** הדו-ספרתי שבנק ישראל מקצה, לא
// לפי השם. "פועלים" / "הפועלים" / "בנק הפועלים" הם אותו בנק ושלוש מחרוזות שונות — ומחרוזת אי אפשר
// לאמת, לחפש לפיה, או לשלוח איתה כסף. הקוד נשמר; השם נגזר ממנו לתצוגה בלבד.
//
// הרשימה מכוונת לבנקים שספק מחזיק בהם חשבון. גופי סליקה (מס"ב 50, שב"א 59, בנק ישראל 99) אינם
// כאן במכוון — אי אפשר להעביר אליהם לספק. בנקים שמוזגו נשארים ומסומנים `legacy`, כי רשומה ישנה
// עדיין נושאת אותם ואסור שתיפול באימות; הם פשוט לא מוצעים בראש הבורר.
//
// מקורות: בנק ישראל (הקצאת קוד 18), ורשימות קודי הבנקים של EasyCount/טרנזילה.

/** @type {Array<{code:string, name:string, legacy?:boolean}>} */
export const BANKS = [
  { code: '12', name: 'בנק הפועלים' },
  { code: '10', name: 'בנק לאומי' },
  { code: '20', name: 'בנק מזרחי טפחות' },
  { code: '11', name: 'בנק דיסקונט' },
  { code: '31', name: 'הבנק הבינלאומי הראשון' },
  { code: '17', name: 'בנק מרכנתיל דיסקונט' },
  { code: '52', name: 'בנק פועלי אגודת ישראל (פאג״י)' },
  { code: '54', name: 'בנק ירושלים' },
  { code: '46', name: 'בנק מסד' },
  { code: '04', name: 'בנק יהב לעובדי המדינה' },
  { code: '09', name: 'בנק הדואר' },
  { code: '18', name: 'ONE ZERO הבנק הדיגיטלי' },
  { code: '34', name: 'בנק ערבי ישראלי' },
  { code: '22', name: 'סיטיבנק' },
  { code: '23', name: 'HSBC' },
  { code: '39', name: 'בנק הודו (SBI)' },
  // מוזגו/נסגרו — נשמרים כדי שרשומה ישנה תמשיך להיות תקפה
  { code: '13', name: 'בנק אגוד (מוזג למזרחי טפחות)', legacy: true },
  { code: '14', name: 'בנק אוצר החייל (מוזג למזרחי טפחות)', legacy: true },
  { code: '26', name: 'יובנק (מוזג לבינלאומי)', legacy: true },
  { code: '68', name: 'בנק דקסיה ישראל', legacy: true },
  { code: '30', name: 'בנק למסחר (נסגר)', legacy: true },
];

const BY_CODE = new Map(BANKS.map((b) => [b.code, b]));

/** '12' → 'בנק הפועלים'. קוד לא מוכר מוחזר כמו שהוא, כדי שרשומה חריגה לא תיעלם מהמסך. */
export function bankName(code) {
  const c = normalizeBankCode(code);
  if (!c) return null;
  return (BY_CODE.get(c) || {}).name || `בנק ${c}`;
}

/** '4' ו-'04' הם אותו בנק. מחזיר תמיד שתי ספרות, או null אם אין קוד. */
export function normalizeBankCode(code) {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(2, '0').slice(-2);
}

export const isKnownBankCode = (code) => BY_CODE.has(normalizeBankCode(code) ?? '');

/**
 * ספרת ביקורת של ת"ז / ח"פ ישראלי (9 ספרות, אלגוריתם בנק ישראל/רשות האוכלוסין).
 * משמש לאימות **שם המוטב** מול המזהה שלו — הזיוף הנפוץ הוא שם ספק אמיתי על חשבון של מישהו אחר.
 */
export function israeliIdValid(id) {
  const s = String(id ?? '').replace(/\D/g, '');
  if (s.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let d = Number(s[i]) * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * IBAN ישראלי: IL + 2 ספרות ביקורת + 19 ספרות (בנק 3 + סניף 3 + חשבון 13), בדיקת mod-97.
 * לא חובה למלא — אבל אם מולא והוא שגוי, זו טעות הקלדה שתחזיר את הכסף (או תשלח אותו למקום אחר).
 */
export function ibanValid(iban) {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^IL\d{21}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  // mod-97 בחלקים, כי המספר ארוך מ-Number.MAX_SAFE_INTEGER
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

/**
 * מנרמל ומאמת קלט של פרטי בנק. מחזיר `{ value, errors, warnings }`:
 *   • `errors`   — חוסמים שמירה. רק דברים שהם בוודאות שגויים (ספרת ביקורת, מבנה).
 *   • `warnings` — נשמרים ומוצגים. דברים חשודים שאסור לחסום, כי לפעמים הם נכונים
 *     (שם מוטב שלא זהה לשם הספק — קורה לגיטימית עם חברת-אם או שם מסחרי).
 *
 * הגבול הזה מכוון: אימות שחוסם שמירה של מצב אמיתי גורם לאנשים לרשום את פרטי הבנק בצד, ואז אין
 * להם תיעוד בכלל. עדיף לשמור עם אזהרה גלויה.
 *
 * @param {{bankCode, bankBranch, bankAccount, bankHolder, holderTaxId, iban}} input
 * @param {{supplierName?: string}} [ctx]
 */
export function validateBankDetails(input = {}, ctx = {}) {
  const clean = (v) => (v ?? '').toString().trim() || null;
  const digitsOnly = (v) => (v == null ? null : String(v).replace(/\D/g, '') || null);

  const value = {
    bank_code: normalizeBankCode(input.bankCode),
    bank_branch: digitsOnly(input.bankBranch),
    bank_account: digitsOnly(input.bankAccount),
    bank_holder: clean(input.bankHolder),
    holder_tax_id: digitsOnly(input.holderTaxId),
    iban: clean(input.iban) ? String(input.iban).replace(/\s+/g, '').toUpperCase() : null,
  };
  value.bank_name = value.bank_code ? bankName(value.bank_code) : null;

  const errors = [];
  const warnings = [];

  if (value.bank_code && !isKnownBankCode(value.bank_code)) {
    errors.push(`קוד בנק ${value.bank_code} אינו מוכר — בחר מהרשימה`);
  }
  // סניף בישראל הוא עד 3 ספרות. 4 ספרות = כמעט תמיד מספר חשבון שהודבק לשדה הלא נכון.
  if (value.bank_branch && value.bank_branch.length > 3) {
    errors.push('מספר סניף הוא עד 3 ספרות — נראה שהוזן כאן מספר חשבון');
  }
  if (value.bank_account && value.bank_account.length > 14) {
    errors.push('מספר חשבון ארוך מדי');
  }
  if (value.holder_tax_id && !israeliIdValid(value.holder_tax_id)) {
    errors.push('ח״פ / ת״ז של המוטב אינו תקין (ספרת ביקורת)');
  }
  if (value.iban && !ibanValid(value.iban)) {
    errors.push('IBAN אינו תקין');
  }

  // חשבון בלי בנק וסניף אי אפשר להעביר אליו — אבל כן אפשר לשמור טיוטה חלקית.
  const any = value.bank_code || value.bank_branch || value.bank_account || value.bank_holder;
  if (any && !(value.bank_code && value.bank_branch && value.bank_account)) {
    warnings.push('חסרים בנק / סניף / מספר חשבון — לא ניתן לבצע העברה לחשבון חלקי');
  }
  if (value.bank_holder && ctx.supplierName && !holderMatchesSupplier(value.bank_holder, ctx.supplierName)) {
    warnings.push(`שם בעל החשבון ("${value.bank_holder}") אינו תואם את שם הספק ("${ctx.supplierName}") — אמת טלפונית`);
  }
  if (!value.bank_holder && any) {
    warnings.push('לא הוזן שם בעל החשבון — זה השדה שמגלה חשבון שהוחלף');
  }

  return { value, errors, warnings };
}

/**
 * האם שם בעל החשבון והספק הם אותו גורם? השוואה סלחנית בכוונה: צורות משפטיות ("בע\"מ"), ניקוד
 * וסימנים יורדים, ומספיקה מילה משמעותית משותפת. המטרה היא לתפוס "יוסי כהן" מול "טרה בע\"מ",
 * לא להתלונן על "טרה תעשיות" מול "טרה".
 */
export function holderMatchesSupplier(holder, supplierName) {
  const norm = (s) => String(s ?? '')
    .replace(/["'׳״.,\-()]/g, ' ')
    .replace(/\b(בע"מ|בעמ|בע מ|ltd|inc|חברת|חב)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const a = norm(holder);
  const b = norm(supplierName);
  if (!a || !b) return true; // אין מה להשוות — לא מתלוננים
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const words = (s) => new Set(s.split(' ').filter((w) => w.length >= 3));
  const wa = words(a);
  for (const w of words(b)) if (wa.has(w)) return true;
  return false;
}

/**
 * ניחוש קוד הבנק משם חופשי — רק בשביל רשומות שנשמרו לפני שהייתה רשימה.
 *
 * **הצעה בלבד.** מוחזרת למסך כדי שהבעלים יאשר בלחיצה, ולעולם לא נכתבת בשקט: "בנק" בכתיב חופשי
 * הוא בדיוק סוג הנתון שאסור להסיק ממנו לאן כסף הולך. שם שמתאים ליותר מבנק אחד מוחזר כ-null.
 */
export function guessBankCode(name) {
  const n = String(name ?? '').replace(/["'׳״.,\-()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  const digits = normalizeBankCode(n.match(/^\d{1,2}$/) ? n : '');
  if (digits && isKnownBankCode(digits)) return digits;
  const norm = (s) => String(s).replace(/^(בנק|הבנק)\s+/, '').replace(/^ה/, '');
  const target = norm(n);
  const hits = BANKS.filter((b) => {
    const bn = norm(b.name.replace(/\s*\(.*\)\s*/g, ''));
    return bn === target || bn.startsWith(target) || target.startsWith(bn);
  });
  return hits.length === 1 ? hits[0].code : null;
}
