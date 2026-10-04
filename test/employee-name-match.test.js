// "(לא ברשימת העובדים)" ליד עובד שכן ברשימה: עובד בלי שם משפחה (ייבוא מקובץ מתיר זאת) הוצג
// כ-"נופר " עם רווח בסוף, והשרת שומר "נופר" אחרי trim — ההשוואה נכשלה תמיד. וגם שורות ישנות
// שנרשמו בטקסט חופשי עם שם פרטי בלבד. matchEmployeeName = כלל אחד לכל טפסי ה"שם".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZClosing } from '../src/services/zclosing.js';
import { importEmployees, createEmployee } from '../src/services/employees.js';
import { employeeFullName, matchEmployeeName } from '../src/lib/employeeName.js';

let server, base;
before(async () => { server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server && server.close());

test('matchEmployeeName: שם מלא, בלי שם משפחה, שם פרטי ייחודי — ושם פרטי כפול נשאר לא מזוהה', () => {
  const emps = [
    { first_name: 'נופר', last_name: '' },
    { first_name: 'זאב', last_name: 'כהן' },
    { first_name: 'דני', last_name: 'לוי' },
    { first_name: 'דני', last_name: 'מזרחי' },
  ];
  assert.equal(employeeFullName(emps[0]), 'נופר');
  assert.equal(matchEmployeeName(emps, 'נופר'), 'נופר');
  assert.equal(matchEmployeeName(emps, 'זאב כהן'), 'זאב כהן');
  assert.equal(matchEmployeeName(emps, 'זאב'), 'זאב כהן', 'שורה ישנה עם שם פרטי בלבד');
  assert.equal(matchEmployeeName(emps, 'דני'), null, 'שני "דני" — לא מנחשים');
  assert.equal(matchEmployeeName(emps, 'מישהו אחר'), null);
  assert.equal(matchEmployeeName(emps, ''), null);
});

test('עריכת סגירת Z: עובד בלי שם משפחה נבחר ולא מסומן "לא ברשימת העובדים"', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  await importEmployees([{ firstName: 'נופר', lastName: '' }], o, db);
  await createEmployee({ firstName: 'זאב', lastName: 'כהן' }, o, db);
  const cid = await createZClosing({
    employeeFirst: 'רות', employeeLast: 'לוי', zNumber: '901', drawerCash: 10000, storeId: st.id,
    counts: { 100: 1 }, registers: [],
    expenses: [
      { payerName: 'נופר ', kind: 'petty', amount: 8240 },          // כפי שהטופס שולח — עם הרווח
      { payerName: 'זאב', kind: 'manual', purpose: 'מתנות לחג', amount: 160000 }, // שורה ישנה, שם פרטי
      { payerName: 'עובד שעזב', kind: 'manual', amount: 100 },
    ],
  }, o, db);
  const saved = await db.many('SELECT payer_name FROM z_closing_expenses WHERE closing_id = ? ORDER BY id', [cid]);
  assert.equal(saved[0].payer_name, 'נופר');

  const html = await (await fetch(`${base}/zclosing/${cid}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.doesNotMatch(html, /נופר \(לא ברשימת העובדים\)/);
  assert.doesNotMatch(html, /זאב \(לא ברשימת העובדים\)/);
  assert.match(html, /value="נופר" data-emp="\d+" selected/);
  assert.match(html, /value="זאב כהן" data-emp="\d+" selected/);
  assert.match(html, /עובד שעזב \(לא ברשימת העובדים\)/, 'שם שבאמת אינו עובד עדיין מסומן');
});
