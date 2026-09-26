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
export async function scrapeHapoalimBiz({
  credentials, startDate, showBrowser = false, failureScreenshotPath = null,
  accountIds = null,
  // 🔴 נמדדו מול המסך החי. **`#user-code` עם מקף** — הפורטל הפרטי משתמש ב-`#userCode` בלי מקף,
  // וזו בדיוק הטעות שהייתה עולה ניסיון התחברות כושל.
  selectors = {
    userCode: '#user-code',
    password: '#password',
    submit: '.submit-btn-container button[type="submit"], button.submit-btn',
  },
  loginUrl = `${BIZ_BASE}/ng-portals/auth/he/`,
}) {
  if (!credentials?.userCode || !credentials?.password) {
    throw new Error('חסרים פרטי התחברות (userCode / password) להפועלים לעסקים');
  }
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch {
    throw new Error('puppeteer אינו מותקן. הוא מגיע עם israeli-bank-scrapers ברץ הסריקה.');
  }

  const browser = await puppeteer.launch({ headless: !showBrowser });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });

    // 🔴 הקלדה אמיתית (`page.type`) ולא השמה ל-`value`. הטופס הוא Angular reactive form
    // (`formcontrolname`), שמקשיב לאירועי קלט — השמה ישירה ל-value ממלאת את השדה על המסך אבל
    // משאירה את הטופס ריק מבחינת Angular, וההתחברות נכשלת עם מסך שנראה מלא.
    await page.waitForSelector(selectors.userCode, { timeout: 30000 });
    await page.type(selectors.userCode, credentials.userCode);
    await page.type(selectors.password, credentials.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null),
      page.click(selectors.submit),
    ]);

    // עדיין על דף ההתחברות = ההתחברות לא עברה. **לא מנסים שוב** — ניסיון שני מקרב נעילה.
    if (/\/auth\//.test(page.url())) {
      if (failureScreenshotPath) await page.screenshot({ path: failureScreenshotPath });
      throw new Error('ההתחברות לפורטל העסקי לא עברה (נשארנו בדף ההתחברות). לא בוצע ניסיון נוסף.');
    }

    // מאיפה מגיעה רשימת החשבונות: אם הוגדרה מפורשות ב-BANK_SCRAPERS — משם, וזה המסלול
    // הוודאי. אחרת שואלים את הבנק. ההגדרה המפורשת קיימת כדי שגילוי החשבונות לא יהיה תנאי
    // להרצה: קבוצה עם שני חשבונות ידועים לא צריכה לחכות לאנדפוינט שאולי נקרא אחרת בפורטל הזה.
    let ids = (accountIds || []).map((x) => String(x).trim()).filter(Boolean);
    if (!ids.length) {
      const accounts = await apiGet(page, `${BIZ_BASE}/ServerServices/general/accounts`);
      ids = (accounts || [])
        .filter((a) => Number(a?.accountClosingReasonCode ?? 0) === 0)
        .map(composeAccountId);
    }
    if (!ids.length) throw new Error('לא נמצאו חשבונות למשיכה בפורטל העסקי');

    const from = yyyymmdd(startDate);
    const to = yyyymmdd(new Date());
    const out = [];
    for (const accountId of ids) {
      const url = `${BIZ_BASE}/ServerServices/current-account/transactions`
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
