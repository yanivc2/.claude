// הפורטל העסקי של הפועלים — המרת שורה גולמית לצורה שהאפליקציה קולטת.
// שמות השדות כאן הם מה שנמדד מול התגובה החיה של biz2.bankhapoalim.co.il, לא מה שהונח.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertBizTransactions, composeAccountId } from '../src/scraper/hapoalimBiz.js';
import { mapScrapedTransactions } from '../src/lib/scraperMap.js';

const row = (over = {}) => ({
  eventDate: 20260901, valueDate: 20260902, eventAmount: 1234.56,
  eventActivityTypeCode: 1, activityDescription: 'העברה', referenceNumber: 55501,
  serialNumber: 7, currentBalance: 1000, ...over,
});

// 🔴 הכלל שקובע סימן. טעות כאן הופכת כל תשלום להכנסה — בשקט, בלי שגיאה.
test('eventActivityTypeCode=2 הוא חיוב (שלילי), וכל השאר זכות', async () => {
  const [debit] = convertBizTransactions([row({ eventActivityTypeCode: 2 })]);
  const [credit] = convertBizTransactions([row({ eventActivityTypeCode: 1 })]);
  assert.equal(debit.chargedAmount, -1234.56);
  assert.equal(credit.chargedAmount, 1234.56);
});

test('תאריך YYYYMMDD מומר לתאריך שהאפליקציה שומרת', async () => {
  const rows = mapScrapedTransactions(convertBizTransactions([row()]), { companyId: 'hapoalimBiz', accountNumber: '12-628-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].txnDate, '2026-09-01');
  assert.equal(rows[0].amount, 123456, 'שקלים → אגורות');
  assert.equal(rows[0].rawReference, '55501', 'האסמכתא היא מפתח ההתאמה מול צ׳קים');
});

// serialNumber=0 = שורה זמנית שנרשמה אחרי סגירת יום העסקים. היא תחזור מאוחר יותר כשורה סופית
// עם מזהה משלה, ולכן קליטתה עכשיו סופרת את אותה תנועה פעמיים.
test('שורה זמנית (serialNumber=0) אינה נקלטת', async () => {
  const raw = convertBizTransactions([row({ serialNumber: 0 }), row({ serialNumber: 3 })]);
  assert.equal(raw[0].status, 'pending');
  assert.equal(raw[1].status, 'completed');
  assert.equal(mapScrapedTransactions(raw, {}).length, 1, 'רק הסופית נקלטת');
});

test('פרטי הצד השני נכנסים לתיאור', async () => {
  const [t] = convertBizTransactions([row({
    activityDescription: 'העברה', beneficiaryDetailsData: { partyName: 'ספק כלשהו', messageDetail: 'חשבונית 90210' },
  })]);
  const [m] = mapScrapedTransactions([t], {});
  assert.match(m.description, /העברה/);
  assert.match(m.description, /ספק כלשהו/);
  assert.match(m.description, /90210/);
});

test('מזהה החשבון נבנה בפורמט שה-API דורש', async () => {
  assert.equal(composeAccountId({ bankNumber: 12, branchNumber: 628, accountNumber: 432110 }), '12-628-432110');
});

// תאריך פגום לא יפיל את המשיכה ולא ייכנס כשורה ריקה.
test('שורה עם תאריך לא תקין נשמטת ואינה מפילה', async () => {
  const raw = convertBizTransactions([row({ eventDate: null }), row()]);
  assert.equal(raw[0].date, null);
  assert.equal(mapScrapedTransactions(raw, {}).length, 1);
});
