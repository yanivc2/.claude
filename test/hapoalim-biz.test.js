// הפורטל העסקי של הפועלים — המרת שורה גולמית לצורה שהאפליקציה קולטת.
// שמות השדות כאן הם מה שנמדד מול התגובה החיה של biz2.bankhapoalim.co.il, לא מה שהונח.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertBizTransactions, composeAccountId, parseBankResponse } from '../src/scraper/hapoalimBiz.js';
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

// 🔴 נמדד בסנכרון החי הראשון: חשבון בלי תנועות בטווח עונה 204/גוף ריק, ו-res.json() זרק
// "Unexpected end of JSON input" — חשבון שקט אחד הפיל את כל הסנכרון.
test('תשובה ריקה מהבנק = אין תנועות, לא שגיאה', () => {
  const url = 'https://biz2.bankhapoalim.co.il/ServerServices/current-account/transactions?accountId=12-628-432110';
  assert.equal(parseBankResponse({ ok: true, status: 204, text: '' }, url), null);
  assert.equal(parseBankResponse({ ok: true, status: 200, text: '  ' }, url), null);
  assert.deepEqual(convertBizTransactions(parseBankResponse({ ok: true, status: 204, text: '' }, url)?.transactions), []);
  assert.deepEqual(parseBankResponse({ ok: true, status: 200, text: '{"transactions":[]}' }, url), { transactions: [] });
});

test('שגיאת בנק לא חושפת את מספר החשבון מה-URL', () => {
  const url = 'https://biz2.bankhapoalim.co.il/ServerServices/current-account/transactions?accountId=12-628-432110';
  assert.throws(() => parseBankResponse({ ok: false, status: 500, text: '' }, url), (e) => !/432110/.test(e.message) && /HTTP 500/.test(e.message));
  assert.throws(() => parseBankResponse({ ok: true, status: 200, text: '<html>' }, url), (e) => !/432110/.test(e.message) && /אינה JSON/.test(e.message));
});

// בעלים 20/10: "יתרה גם בשורות שמגיעות מהסוכן" — הפורטל מוסר currentBalance לכל שורה; בלעדיו בדיקת רצף
// היתרות לא רואה את מה שהסוכן הביא.
test('currentBalance → balance → balanceAfter (agorot); missing stays null, never 0', () => {
  const [withBal] = convertBizTransactions([row({ currentBalance: 15234.07 })]);
  assert.equal(withBal.balance, 15234.07);
  const [noBal] = convertBizTransactions([row({ currentBalance: undefined })]);
  assert.equal(noBal.balance, null);
  const [emptyBal] = convertBizTransactions([row({ currentBalance: '' })]);
  assert.equal(emptyBal.balance, null);
  const [mapped] = mapScrapedTransactions(convertBizTransactions([row({ currentBalance: 15234.07 })]), { companyId: 'hapoalimBiz', accountNumber: '12-628-1' });
  assert.equal(mapped.balanceAfter, 1523407);
  const [mappedNo] = mapScrapedTransactions(convertBizTransactions([row({ currentBalance: null })]), { companyId: 'hapoalimBiz', accountNumber: '12-628-1' });
  assert.equal(mappedNo.balanceAfter, null);
});

test('a row pulled before the balance existed gets it on the next pull — an existing balance is never overwritten', async () => {
  const { freshDb, owner } = await import('./helpers.js');
  const { importTransactions } = await import('../src/services/bankTransactions.js');
  const db = await freshDb();
  const o = await owner(db);
  const acct = await db.one('SELECT id FROM bank_accounts WHERE store_id = 3 LIMIT 1', []);
  const ctx = { companyId: 'hapoalimBiz', accountNumber: '12-628-1' };
  const pull = (bal) => mapScrapedTransactions(convertBizTransactions([row({ referenceNumber: 77001, currentBalance: bal })]), ctx);
  // the agent before this change: no balance
  const first = pull(null);
  assert.equal(first[0].balanceAfter, null);
  assert.equal((await importTransactions(acct.id, first, 'scraper', o, db)).inserted, 1);
  const get = () => db.one('SELECT balance_after FROM bank_transactions WHERE bank_account_id = ? AND external_id = ?', [acct.id, first[0].externalId]);
  assert.equal((await get()).balance_after, null);
  // the updated agent re-pulls the same window: same row, now with its balance — filled, not re-inserted
  const r = await importTransactions(acct.id, pull(5000), 'scraper', o, db);
  assert.equal(r.inserted, 0);
  assert.equal(Number((await get()).balance_after), 500000);
  // a later pull with a different figure does not overwrite what is there
  await importTransactions(acct.id, pull(6000), 'scraper', o, db);
  assert.equal(Number((await get()).balance_after), 500000);
});

// בעלים 20/10: "צילום הצ׳ק מהבנק — לבדוק אם הסוכן יכול למשוך אותו". אין תיעוד ציבורי, ולכן הסוכן מוסר פעם אחת
// אילו **שמות שדות** הבנק מחזיר בשורת צ׳ק — בלי אף ערך.
test('checkRowKeys: field names of check rows only — never a value', async () => {
  const { checkRowKeys } = await import('../src/scraper/hapoalimBiz.js');
  const p = checkRowKeys([
    row({ activityDescription: 'שיק', referenceNumber: 9001, chequeImageUrl: '/secret/path?token=abc', beneficiaryDetailsData: { partyName: 'ספק סודי' } }),
    row({ activityDescription: "צ'ק מוחזר", referenceNumber: 9002 }),
    row({ activityDescription: 'משיכה בכרטיס', atmSecretField: 'x' }),
  ]);
  assert.equal(p.checkRows, 2, '"משיכה" is not a check');
  assert.ok(p.keys.includes('chequeImageUrl') && p.keys.includes('beneficiaryDetailsData.partyName'));
  assert.ok(!p.keys.includes('atmSecretField'), 'non-check rows are not read');
  const flat = JSON.stringify(p);
  for (const v of ['secret/path', 'token=abc', 'ספק סודי', '9001']) assert.ok(!flat.includes(v), `no value leaks: ${v}`);
});

test('the probe reaches the owner once, through the sync result; junk names and empty probes are dropped', async () => {
  const { freshDb, owner } = await import('./helpers.js');
  const { requestSync, claimNext, completeWithAccounts } = await import('../src/services/bankSyncJobs.js');
  const db = await freshDb();
  const o = await owner(db);
  const notes = async () => db.many("SELECT title, body FROM notifications WHERE title LIKE '%צילום צ׳ק%'", []);
  const sync = async (probe) => {
    const job = await requestSync(o, db);
    await claimNext('office-pc', db);
    await completeWithAccounts(job.id, { accounts: [{ accountNumber: '999999999', transactions: [] }], probe }, 'office-pc', db);
  };
  await sync({ checkRows: 0, keys: ['eventAmount'] });
  assert.equal((await notes()).length, 0, 'no check row in this sync — wait for one');
  await sync({ checkRows: 3, keys: ['eventAmount', 'chequeImageUrl', '<script>', 'שדה'] });
  const n = await notes();
  assert.equal(n.length, 1);
  assert.match(n[0].body, /eventAmount, chequeImageUrl/);
  assert.match(n[0].body, /שדות שאולי מובילים לצילום: chequeImageUrl/);
  assert.doesNotMatch(n[0].body, /script|שדה/, 'only latin field names pass');
  await sync({ checkRows: 5, keys: ['other'] });
  assert.equal((await notes()).length, 1, 'once');
});

// שלב 2 (בעלים 20/10, "כן, תעשה"): בשורת הצ׳ק אין קישור לצילום, אבל pfmDetails הוא קישור ל"פרטים נוספים" — הסוכן
// פותח אותו לשורת צ׳ק אחת ומדווח את נתיב הקישור (בלי query) ואת שמות השדות שבתשובה. בלי ערכים.
test('stage 2 helpers: field names of the details response and the bare path — no values', async () => {
  const { responseKeys, pathOnly } = await import('../src/scraper/hapoalimBiz.js');
  const keys = responseKeys([{ transactionNumber: 77123, chequeImage: { url: '/img/secret?token=zzz' }, rows: [{ payee: 'ספק סודי' }] }]);
  assert.deepEqual(keys, ['chequeImage', 'chequeImage.url', 'rows', 'rows[].payee', 'transactionNumber']);
  const flat = JSON.stringify(keys);
  for (const v of ['77123', 'secret', 'token', 'ספק סודי']) assert.ok(!flat.includes(v), `no value leaks: ${v}`);
  assert.equal(pathOnly('/ServerServices/current-account/transactions/details?eventId=123&accountId=12-628-1'), '/ServerServices/current-account/transactions/details');
  assert.equal(pathOnly('https://evil.example/x'), null, 'only a relative bank path');
  assert.equal(pathOnly('/a b'), null);
});

test('stage 2 reaches the owner once — even after stage 1 was already reported; a failed call is reported too', async () => {
  const { freshDb, owner } = await import('./helpers.js');
  const { reportCheckProbe } = await import('../src/services/bankSyncJobs.js');
  const db = await freshDb();
  await owner(db);
  const titles = async () => (await db.many('SELECT title, body FROM notifications ORDER BY id', []));
  await reportCheckProbe({ checkRows: 2, keys: ['eventAmount'] }, db); // stage 1 (as tonight)
  await reportCheckProbe({ checkRows: 2, keys: ['eventAmount'], details: { path: '/ServerServices/x/details', keys: ['transactionNumber', 'imageLink'], error: null } }, db);
  let n = await titles();
  assert.equal(n.length, 2);
  assert.match(n[1].title + n[1].body, /שלב 2/);
  assert.match(n[1].body, /\/ServerServices\/x\/details/);
  assert.match(n[1].body, /transactionNumber, imageLink/);
  assert.match(n[1].body, /שדות שאולי מובילים לצילום: imageLink/);
  await reportCheckProbe({ checkRows: 2, keys: ['x'], details: { path: '/y', keys: ['z'] } }, db);
  assert.equal((await titles()).length, 2, 'once');

  const db2 = await freshDb();
  await owner(db2);
  await reportCheckProbe({ checkRows: 1, keys: ['a'], details: { path: '/p?secret=1', keys: [], error: 'HTTP 404 /p' } }, db2);
  const m = await db2.many("SELECT body FROM notifications WHERE title LIKE '%שלב 2%' OR body LIKE '%שלב 2%'", []);
  assert.equal(m.length, 1);
  assert.match(m[0].body, /הקריאה לא הצליחה: HTTP 404 \/p/);
  assert.doesNotMatch(m[0].body, /secret/, 'a path with a query is not echoed');
});
