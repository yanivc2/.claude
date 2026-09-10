// "הוסף שטרות" / "החסר שטרות" — הוספה והחסרה של שטרות לספירה קיימת, בלי חשבון בראש.
//
// המצב שזה פותר: סופרים 15 שטרות של ₪200, ואז מגיעה עוד חבילה עם 20. בלי זה צריך לחשב 35
// ולהקליד מחדש — וכל טעות בחיבור הזה היא פער מזומן שמישהו יחפש אחר כך.
//
// עובד על כל טבלה שמסומנת `data-count-adjust`: הכמויות הן ה-`input[data-val]` שבתוכה, והתווית
// של כל שטר נלקחת מהתא הראשון בשורה. לכן אותה טכניקה משרתת גם את ספירת המגירה וגם כל בלוק קופה
// ב"איזון קופות", כולל בלוקים שנוצרים אחרי טעינת הדף (`window.apCountAdjust(root)`).
(function () {
  var dlg = null, mode = 'add', target = null;

  function rows(table) {
    return Array.prototype.slice.call(table.querySelectorAll('input[data-val]')).map(function (inp) {
      var tr = inp.closest('tr');
      var label = tr && tr.cells[0] ? tr.cells[0].textContent.replace(/\s+/g, ' ').trim() : inp.dataset.val;
      return { input: inp, label: label, value: Number(inp.dataset.val) || 0 };
    });
  }

  function ensureDialog() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'count-adjust-dlg';
    dlg.innerHTML =
      '<h3 tabindex="-1" autofocus style="margin:0 0 .3rem;outline:none"></h3>'
      + '<p class="muted" style="margin:0 0 .6rem">בחר שטר והזן כמה להוסיף. הכמות בטבלה תתעדכן — אין צורך לחשב.</p>'
      + '<div class="row">'
      + '  <div><label>שטר / מטבע</label><select class="ca-denom"></select></div>'
      + '  <div><label>כמות</label><input class="ca-qty" inputmode="numeric" placeholder="0" autocomplete="off"></div>'
      + '</div>'
      + '<p class="ca-msg muted" style="margin:.5rem 0 0;min-height:1.2em"></p>'
      + '<div class="actions" style="margin-top:.6rem">'
      + '  <button type="button" class="ca-apply"></button>'
      + '  <button type="button" class="btn-secondary ca-close">סיום</button>'
      + '</div>';
    document.body.appendChild(dlg);
    dlg.querySelector('.ca-close').addEventListener('click', function () { dlg.close(); });
    dlg.querySelector('.ca-apply').addEventListener('click', apply);
    // Enter בשדה הכמות = החלה, כי זו הפעולה היחידה בחלון.
    dlg.querySelector('.ca-qty').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
    });
    return dlg;
  }

  function open(table, how) {
    mode = how; target = table;
    var d = ensureDialog();
    var list = rows(table);
    d.querySelector('h3').textContent = how === 'add' ? 'הוספת שטרות לספירה' : 'החסרת שטרות מהספירה';
    d.querySelector('.ca-apply').textContent = how === 'add' ? '➕ הוסף' : '➖ החסר';
    d.querySelector('.ca-msg').textContent = '';
    var sel = d.querySelector('.ca-denom');
    sel.innerHTML = list.map(function (r, i) {
      return '<option value="' + i + '">' + r.label + ' · כמות כעת: ' + (parseInt(r.input.value, 10) || 0) + '</option>';
    }).join('');
    d.querySelector('.ca-qty').value = '';
    d.showModal();
    d.querySelector('.ca-qty').focus();
  }

  function apply() {
    if (!target) return;
    var d = dlg;
    var list = rows(target);
    var r = list[Number(d.querySelector('.ca-denom').value)];
    var n = parseInt(d.querySelector('.ca-qty').value, 10);
    var msg = d.querySelector('.ca-msg');
    if (!r || !Number.isFinite(n) || n <= 0) { msg.textContent = 'יש להזין כמות גדולה מאפס.'; msg.style.color = 'var(--color-bad)'; return; }

    var before = parseInt(r.input.value, 10) || 0;
    // כמות שלילית של שטרות אינה מצב אפשרי — החסרה נעצרת באפס ואומרת מה קרה.
    var after = mode === 'add' ? before + n : Math.max(0, before - n);
    r.input.value = String(after);
    // אותו אירוע שהקלדה ידנית מייצרת, כדי שסכומי הביניים והסה"כ יתעדכנו בדיוק כמו תמיד.
    r.input.dispatchEvent(new Event('input', { bubbles: true }));

    if (mode === 'sub' && before - n < 0) {
      msg.textContent = 'היו רק ' + before + ' — הכמות אופסה.';
      msg.style.color = 'var(--color-bad)';
    } else {
      msg.textContent = (mode === 'add' ? 'נוספו ' : 'הוחסרו ') + n + ' · כמות כעת: ' + after;
      msg.style.color = 'var(--color-ok)';
    }
    // הרשימה נבנית מחדש כדי שה"כמות כעת" בבורר תשקף את המצב, ואפשר להמשיך לשטר הבא.
    var keep = d.querySelector('.ca-denom').value;
    var sel = d.querySelector('.ca-denom');
    sel.innerHTML = rows(target).map(function (x, i) {
      return '<option value="' + i + '">' + x.label + ' · כמות כעת: ' + (parseInt(x.input.value, 10) || 0) + '</option>';
    }).join('');
    sel.value = keep;
    d.querySelector('.ca-qty').value = '';
    d.querySelector('.ca-qty').focus();
  }

  function enhance(table) {
    if (table.dataset.caDone) return; table.dataset.caDone = '1';
    var bar = document.createElement('div');
    bar.className = 'actions count-adjust-bar no-print';
    var add = document.createElement('button');
    add.type = 'button'; add.className = 'btn-secondary btn-sm'; add.textContent = '➕ הוסף שטרות';
    var sub = document.createElement('button');
    sub.type = 'button'; sub.className = 'btn-secondary btn-sm'; sub.textContent = '➖ החסר שטרות';
    add.addEventListener('click', function () { open(table, 'add'); });
    sub.addEventListener('click', function () { open(table, 'sub'); });
    bar.appendChild(add); bar.appendChild(sub);
    var anchor = table.closest('.table-scroll') || table;
    anchor.parentNode.insertBefore(bar, anchor);
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('table[data-count-adjust]').forEach(enhance);
  }
  window.apCountAdjust = enhanceAll;  // בלוק קופה שנוצר אחרי טעינת הדף
  document.addEventListener('DOMContentLoaded', function () { enhanceAll(); });
})();
