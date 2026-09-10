// "הוסף שטרות" / "החסר שטרות" בספירת המזומן (public/count-adjust.js).
//
// המצב: סופרים 15 שטרות של ₪200, ואז מגיעה עוד חבילה עם 20. בלי זה צריך לחשב 35 בראש ולהקליד
// מחדש — וכל טעות בחיבור הזה הופכת לפער מזומן שמישהו יחפש אחר כך.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const js = read('src/public/count-adjust.js');

test('it drives the same inputs the totals already listen to', () => {
  // The quantity fields carry data-val (the denomination) — keying on that is what lets one
  // implementation serve the drawer count AND every register block.
  assert.match(js, /querySelectorAll\('input\[data-val\]'\)/);
  // Setting .value alone would leave every subtotal stale; the existing recalc listens for `input`.
  assert.match(js, /dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
});

test('subtracting below zero floors at zero and says so', () => {
  assert.match(js, /Math\.max\(0, before - n\)/, 'a negative count of notes is not a state that exists');
  assert.match(js, /היו רק/, 'and the user is told what actually happened');
});

test('a quantity of zero or nonsense is refused, not silently applied', () => {
  assert.match(js, /!Number\.isFinite\(n\) \|\| n <= 0/);
});

test('both closing screens mark their count tables, including a register added after load', () => {
  for (const p of ['src/views/zclosing/index.ejs', 'src/views/zclosing/edit.ejs']) {
    const v = read(p);
    assert.equal((v.match(/data-count-adjust/g) || []).length, 2,
      `${p}: the drawer table and the register-block template`);
    assert.match(v, /if \(window\.apCountAdjust\) window\.apCountAdjust\(div\)/,
      `${p}: a register added after load must get the buttons too`);
    assert.match(v, /<script src="\/count-adjust\.js" defer><\/script>/, `${p}: the script is loaded`);
  }
});
