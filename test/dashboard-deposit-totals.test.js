// לוח הבקרה: "תשלום במזומן ללא התאמה" מכווץ כברירת מחדל; בהיסטוריית ההפקדות — סה"כ גם
// בעמודות "יתרה / חוסר" ו"אימות ספירה" (קודם היה סה"כ רק לסכום ההפקדה).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { formatIls } from '../src/lib/money.js';
import { depositStatus } from '../src/services/deposits.js';

const views = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');
const render = (locals) => ejs.renderFile(path.join(views, 'partials', '_deposits.ejs'), {
  formatIls, formatDate: (d) => d, depositStatus, ...locals,
});
const footer = (html) => html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'));
const span = (f) => [...f.matchAll(/<th\b([^>]*)>/g)].reduce((n, m) => n + Number((m[1].match(/colspan="(\d+)"/) || [0, 1])[1]), 0);

test('סה"כ יתרה/חוסר ואימות ספירה — רק שורות עם נתון; "—" לא נספר כאפס', async () => {
  const rows = [
    { id: 1, amount: 100000, deposited: 1 },
    { id: 2, amount: 50000, deposited: 1 },
    { id: 3, amount: 20000, deposited: 0 },
  ];
  const zdiff = new Map([[1, 1500], [2, -4000]]); // שורה 3 — בלי Z
  const verify = new Map([
    [1, { state: 'corrected', correctionTotal: -2000, statusDate: '2026-09-02' }],
    [2, { state: 'verified', statusDate: '2026-09-03' }],
  ]);
  const f = footer(await render({ rows, zdiff, verify, actions: false }));
  assert.match(f, /₪1,700\.00/, 'סכום ההפקדות');
  assert.match(f, /חוסר ₪25\.00/, '1500 − 4000 = חוסר 25');
  assert.match(f, /−₪20\.00/, 'תיקון הבנק');
  assert.equal(span(f), 9, '9 עמודות בלי פעולות — כמו הכותרת');
  const f2 = footer(await render({ rows, zdiff, verify, actions: true }));
  assert.equal(span(f2), 10, '10 עם עמודת הפעולות');
});

test('בלי נתונים — "—" ולא אפס מטעה', async () => {
  const f = footer(await render({ rows: [{ id: 9, amount: 100, deposited: 0 }], zdiff: new Map(), verify: new Map(), actions: false }));
  assert.equal((f.match(/<span class="muted">—<\/span>/g) || []).length, 2);
});

test('לוח הבקרה: "תשלום במזומן ללא התאמה" מכווץ כברירת מחדל', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(views, 'dashboard.ejs'), 'utf8');
  assert.match(src, /<details class="card collapse" id="unmatched-cash">/, 'details בלי open = מכווץ');
});
