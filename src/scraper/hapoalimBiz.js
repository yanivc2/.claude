// בנק הפועלים — **הפורטל העסקי** (biz2.bankhapoalim.co.il).
//
// `israeli-bank-scrapers` תומך בהפועלים **הפרטי** בלבד (login.bankhapoalim.co.il), ושם ה-baseUrl
// מקודד קשיח. החשבון של הקבוצה הוא עסקי, ולכן הקוד כאן — אבל הוא קטן בהרבה ממה שנראה בהתחלה:
// 🔴 **שני הפורטלים יושבים על אותו backend.** נמדד מול הפורטל העסקי החי: אותו נתיב
// (`/ServerServices/current-account/transactions`), אותם פרמטרים (`accountId`, `numItemsPerPage`,
// `sortCode`, `retrievalStartDate`, `retrievalEndDate`), אותה שיטה (POST), אותה כותרת
// (`x-xsrf-token`), ו**אותם שמות שדות בדיוק** בתגובה. לכן מה שנכתב כאן הוא הדלת בלבד; ההמרה
// זהה לזו של הפורטל הפרטי.
//
// `x-b3-traceid`/`x-dtpc` שמופיעות בדפדפן הן כותרות ניטור של הבנק ואינן נדרשות.

import { mapScrapedTransactions } from '../lib/scraperMap.js';

export const BIZ_BASE = 'https://biz2.bankhapoalim.co.il';

/** 20260927 → '2026-09-27T00:00:00.000Z'. מחזיר null לכל דבר שאינו YYYYMMDD. */
function bankDateToIso(n) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(n ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z` : null;
}

/**
 * שורת בנק גולמית → הצורה ש-`lib/scraperMap.js` מצפה לה (אותה צורה שהספרייה מייצרת), כדי
 * שההמרה ל-`bank_transactions` תישאר **ביטוי אחד** המשותף לכל המוסדות.
 *
 * 🔴 `eventActivityTypeCode === 2` הוא חיוב. זו השורה שקובעת סימן, וטעות בה הופכת כל תשלום
 * להכנסה — בשקט, בלי שגיאה, עם מסך שנראה תקין.
 * 🔴 `serialNumber === 0` = שורה זמנית שנרשמה אחרי סגירת יום העסקים (הבנק אומר זאת מפורשות
 * ב-metadata): הסכום עוד עשוי להשתנות, והיא תחזור מאוחר יותר כשורה סופית עם מזהה משלה.
 * מסומנת `pending`, ו-`mapScrapedTransactions` מסנן אותה — אחרת אותה תנועה נספרת פעמיים.
 */
export function convertBizTransactions(rows) {
  return (rows || []).map((t) => {
    const outbound = Number(t?.eventActivityTypeCode) === 2;
    const amount = Number(t?.eventAmount);
    const signed = Number.isFinite(amount) ? (outbound ? -amount : amount) : null;

    // פרטי הצד השני, כשהבנק מוסר אותם — זה מה שהופך "העברה" ל"העברה למי".
    const b = t?.beneficiaryDetailsData || {};
    const memo = [b.partyHeadline, b.partyName, b.messageHeadline, b.messageDetail]
      .map((p) => String(p ?? '').trim())
      .filter(Boolean)
      .join(' ');

    return {
      date: bankDateToIso(t?.eventDate),
      processedDate: bankDateToIso(t?.valueDate),
      originalAmount: signed,
      originalCurrency: 'ILS',
      chargedAmount: signed,
      description: String(t?.activityDescription ?? '').trim(),
      memo,
      identifier: t?.referenceNumber ?? null,
      status: Number(t?.serialNumber) === 0 ? 'pending' : 'completed',
    };
  });
}

/** `{bankNumber, branchNumber, accountNumber}` → `12-628-432110`, הפורמט ש-accountId מצפה לו. */
export function composeAccountId(a) {
  return `${a?.bankNumber}-${a?.branchNumber}-${a?.accountNumber}`;
}

/** YYYYMMDD מתוך Date. */
function yyyymmdd(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * קריאה ל-API של הבנק **מתוך הדף** ולא מתוך node. זו הנקודה שבה אנחנו לא נוגעים באף סוד:
 * העוגיות נוסעות לבד, ואת ה-XSRF קוראים מהעוגייה שהבנק עצמו כתב. שום טוקן אינו עובר דרך
 * הקוד שלנו, אינו נשמר, ואינו נרשם ללוג.
 */
async function apiPost(page, url) {
  return page.evaluate(async (u) => {
    const xsrf = (document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/) || [])[1];
    const res = await fetch(u, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
      },
      body: '[]',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`);
    return res.json();
  }, url);
}

async function apiGet(page, url) {
  return page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`);
    return res.json();
  }, url);
}

/**
 * התחבר לפורטל העסקי ומשוך את כל החשבונות הפתוחים.
 *
 * ⚠️ `selectors` עדיין לא אומתו מול המסך החי. עד שיאומתו הפונקציה הזו לא מורצת: כל ניסיון
 * התחברות כושל נספר אצל הבנק, והבנק נועל גישה אחרי כמה כשלונות.
 *
 * @returns {Promise<Array<{accountNumber:string, transactions:Array}>>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OTP_TEXT = /קוד אימות|קוד חד[- ]פעמי/;

/**
 * אחרי לחיצה — מה קרה? שלוש תוצאות: נכנסנו (`in`), הבנק מבקש קוד (`otp`), או תקועים (`stuck`).
 * 🔴 נבדק מצד node בלולאה ולא ב-`waitForFunction`: ניווט באמצע הבדיקה הורס את ה-context של
 * הדף וזורק, ובנוסף חלון הקוד **אינו ניווט** — המתנה ל-`waitForNavigation` הייתה מבזבזת את
 * כל ה-timeout (60 שניות, נמדד בהרצה) לפני שמבינים שהבנק בכלל מחכה לקוד.
 */
async function loginOutcome(page, seconds = 60) {
  for (let i = 0; i < seconds; i += 1) {
    await sleep(1000);
    if (!/\/auth\//.test(page.url())) return 'in';
    const otp = await page.evaluate((re) => new RegExp(re).test(document.body?.innerText || ''), OTP_TEXT.source)
      .catch(() => false);
    if (otp) return 'otp';
  }
  return 'stuck';
}

/**
 * מקליד את הקוד בחלון שהבנק פתח ולוחץ "כניסה לחשבונך". 🔴 השדה נמצא לפי **מה שהוא** ולא לפי
 * id: השדה הגלוי היחיד בדף שאינו קוד המשתמש או הסיסמה. ה-id של חלון הקוד לא נמדד מול המסך החי,
 * וסלקטור מנוחש שנכשל = קוד שפג תוקפו + התחברות שהלכה לפח.
 */
async function enterOtp(page, code) {
  const input = await page.evaluateHandle(() => {
    const seen = (e) => e.offsetParent !== null && !e.disabled && !e.readOnly;
    return [...document.querySelectorAll('input')]
      .filter((e) => seen(e) && !['user-code', 'password'].includes(e.id) && !['hidden', 'checkbox', 'radio'].includes(e.type))
      .pop() || null;
  });
  const field = input.asElement();
  if (!field) throw new Error('לא נמצא שדה קוד האימות בחלון של הבנק.');
  await field.click({ clickCount: 3 });
  await field.type(code, { delay: 60 });

  const btn = (await page.evaluateHandle(() => {
    const seen = (e) => e.offsetParent !== null && !e.disabled;
    return [...document.querySelectorAll('button, a, [role=button]')]
      .find((e) => seen(e) && /כניסה לחשבונך/.test(e.innerText || '')) || null;
  })).asElement();
  if (btn) await btn.click();
  else await field.press('Enter');
}

/**
 * התחבר לפורטל העסקי ומשוך את כל החשבונות הפתוחים.
 *
 * `onOtp` — פונקציה שמחזירה את הקוד שהגיע ב-SMS (הסוכן במחשב המשרד מממש אותה: מבקש מהאפליקציה
 * להציג שדה קוד וממתין לו). בלעדיה, מסך הקוד = כישלון מפורש, כי אף אחד לא יכול להקליד אותו.
 * `onProgress` — הודעות התקדמות למי שמחכה מול המסך.
 *
 * 🔴 ניסיון אחד בלבד — להתחברות ולקוד. כל כישלון נספר אצל הבנק, והבנק נועל גישה אחרי כמה.
 *
 * @returns {Promise<Array<{accountNumber:string, transactions:Array}>>}
 */
export async function scrapeHapoalimBiz({
  credentials, startDate, showBrowser = false, failureScreenshotPath = null,
  accountIds = null, onOtp = null, onProgress = null, puppeteer = null, executablePath = null,
  // הבסיס ניתן להחלפה: לבדיקה מקצה לקצה מול בנק מדומה, ולמקרה שהבנק יעבור מ-biz2 לשרת אחר.
  baseUrl = BIZ_BASE,
  // 🔴 נמדדו מול המסך החי. **`#user-code` עם מקף** — הפורטל הפרטי משתמש ב-`#userCode` בלי מקף,
  // וזו בדיוק הטעות שהייתה עולה ניסיון התחברות כושל.
  selectors = {
    userCode: '#user-code',
    password: '#password',
    submit: '.submit-btn-container button[type="submit"], button.submit-btn',
  },
  loginUrl = null,
}) {
  const base = String(baseUrl || BIZ_BASE).replace(/\/+$/, '');
  const loginAt = loginUrl || `${base}/ng-portals/auth/he/`;
  if (!credentials?.userCode || !credentials?.password) {
    throw new Error('חסרים פרטי התחברות (userCode / password) להפועלים לעסקים');
  }
  const progress = (m) => { try { onProgress?.(m); } catch { /* התקדמות אינה קריטית */ } };

  // puppeteer מוזרק מבחוץ כשהקוד רץ מהסוכן (agent/), שמחזיק node_modules משלו; אחרת — מהרץ.
  let pptr = puppeteer;
  if (!pptr) {
    try {
      ({ default: pptr } = await import('puppeteer'));
    } catch {
      throw new Error('puppeteer אינו מותקן. הוא מגיע עם israeli-bank-scrapers ברץ הסריקה.');
    }
  }

  const browser = await pptr.launch({ headless: !showBrowser, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    progress('פותח את אתר הבנק…');
    await page.goto(loginAt, { waitUntil: 'networkidle2' });

    // 🔴 הקלדה אמיתית (`page.type`) ולא השמה ל-`value`. הטופס הוא Angular reactive form
    // (`formcontrolname`), שמקשיב לאירועי קלט — השמה ישירה ל-value ממלאת את השדה על המסך אבל
    // משאירה את הטופס ריק מבחינת Angular, וההתחברות נכשלת עם מסך שנראה מלא.
    await page.waitForSelector(selectors.userCode, { timeout: 30000 });
    await page.type(selectors.userCode, credentials.userCode);
    await page.type(selectors.password, credentials.password);
    progress('מתחבר לבנק…');
    await page.click(selectors.submit);

    let outcome = await loginOutcome(page);

    // 🔴 להבחין בין "פרטים שגויים" לבין "הבנק מבקש קוד חד-פעמי". נמדד: הפורטל העסקי קיבל את
    // הפרטים ועבר למסך "קוד אימות נשלח לסלולרי שלך" — ההתחברות **הצליחה** והעצירה היא אימות
    // דו-שלבי. בכתובת ה-URL שתי המשמעויות נראות זהות.
    if (outcome === 'otp') {
      if (!onOtp) {
        if (failureScreenshotPath) await page.screenshot({ path: failureScreenshotPath });
        throw new Error(
          'הבנק דורש קוד אימות חד-פעמי ל-SMS. הפרטים נכונים וההתחברות עברה, אבל ריצה בלי אדם '
          + 'לא יכולה להקליד קוד שנשלח לטלפון. השתמש בכפתור הסנכרון באפליקציה (סוכן מחשב המשרד).',
        );
      }
      const code = await onOtp(); // הסוכן: מבקש מהאפליקציה שדה קוד, ממתין, מחזיר את מה שהוזן
      progress('מאמת את הקוד מול הבנק…');
      await enterOtp(page, code);
      outcome = await loginOutcome(page, 45);
      if (outcome !== 'in') {
        if (failureScreenshotPath) await page.screenshot({ path: failureScreenshotPath });
        throw new Error('הבנק לא קיבל את הקוד (שגוי או שפג תוקפו). לחץ "סנכרן" שוב לקבלת קוד חדש.');
      }
    }

    // עדיין על דף ההתחברות = ההתחברות לא הושלמה. **לא מנסים שוב** — ניסיון שני מקרב נעילה.
    if (outcome !== 'in') {
      if (failureScreenshotPath) await page.screenshot({ path: failureScreenshotPath });
      throw new Error('ההתחברות לפורטל העסקי לא עברה (נשארנו בדף ההתחברות). לא בוצע ניסיון נוסף.');
    }
    progress('מחובר — מושך תנועות…');

    // מאיפה מגיעה רשימת החשבונות: אם הוגדרה מפורשות ב-BANK_SCRAPERS — משם, וזה המסלול
    // הוודאי. אחרת שואלים את הבנק. ההגדרה המפורשת קיימת כדי שגילוי החשבונות לא יהיה תנאי
    // להרצה: קבוצה עם שני חשבונות ידועים לא צריכה לחכות לאנדפוינט שאולי נקרא אחרת בפורטל הזה.
    let ids = (accountIds || []).map((x) => String(x).trim()).filter(Boolean);
    if (!ids.length) {
      let accounts;
      try {
        accounts = await apiGet(page, `${base}/ServerServices/general/accounts?lang=he`);
      } catch (e) {
        throw new Error(`גילוי החשבונות נכשל (${e.message}). הגדר accountIds (בנק-סניף-חשבון) כדי לעקוף אותו.`);
      }
      ids = (accounts || [])
        .filter((a) => Number(a?.accountClosingReasonCode ?? 0) === 0)
        .map(composeAccountId)
        // 🔴 מזהה שנבנה חלקית הוא גרוע ממזהה חסר: הוא היה נשלח לבנק, חוזר ריק, והמשיכה
        // הייתה מדווחת "0 תנועות" — כלומר נראית כמו הצלחה שקטה מול חשבון שלא נבדק כלל.
        .filter((id) => !/undefined|null/.test(id));
    }
    if (!ids.length) {
      throw new Error(
        'לא נמצאו חשבונות למשיכה בפורטל העסקי. הוסף accountIds ל-BANK_SCRAPERS '
        + '(פורמט בנק-סניף-חשבון) כדי לא להיות תלוי בגילוי אוטומטי.',
      );
    }

    const from = yyyymmdd(startDate);
    const to = yyyymmdd(new Date());
    const out = [];
    for (const accountId of ids) {
      const url = `${base}/ServerServices/current-account/transactions`
        + `?numItemsPerPage=500&sortCode=1&retrievalEndDate=${to}&retrievalStartDate=${from}`
        + `&accountId=${encodeURIComponent(accountId)}&lang=he`;
      const body = await apiPost(page, url);
      const txns = convertBizTransactions(body?.transactions);
      out.push({
        accountNumber: accountId,
        transactions: mapScrapedTransactions(txns, { companyId: 'hapoalimBiz', accountNumber: accountId }),
      });
    }
    return out;
  } finally {
    await browser.close();
  }
}
