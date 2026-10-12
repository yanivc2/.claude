// "עבור" של הוצאת מזומן מסוג חשבונית — כמה חשבוניות לשורה (בעלים, 2026-10-12).
//
// כל שורה שולחת שדה מוסתר אחד `expense_invoice_id` = "12,15", ולא שדה לכל חשבונית: השרת מצמיד
// את שדות השורות לפי אינדקס (סכום[i] ↔ חשבונית[i]), ושדה נוסף היה מזיז את כל השורות שאחריו.
// הבורר עצמו הוא <select> בלי name — בחירה בו מוסיפה תגית ומתאפסת.
// משותף לשלושת הטפסים: דוח Z (views/reports/_zform.ejs), סגירת Z ועריכתה (views/zclosing/*).
(function () {
  function hidden(box) { return box.querySelector('.cx-inv-ids'); }
  function idsOf(box) {
    var h = hidden(box);
    return String((h && h.value) || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function setIds(box, ids) { var h = hidden(box); if (h) h.value = ids.join(','); }
  function labelFor(box, id) {
    var sel = box.querySelector('select.cx-inv');
    var opt = sel && sel.querySelector('option[value="' + String(id).replace(/"/g, '') + '"]');
    // "#58 · ספק · מספר · ₪סכום" — המזהה הפנימי הוא רעש בתגית צרה.
    return opt ? opt.textContent.replace(/^#\d+\s*·\s*/, '') : 'חשבונית #' + id;
  }
  function render(box) {
    var chips = box.querySelector('.cx-inv-chips');
    var sel = box.querySelector('select.cx-inv');
    if (!chips) return;
    var ids = idsOf(box);
    chips.textContent = '';
    ids.forEach(function (id) {
      var chip = document.createElement('span');
      chip.className = 'cx-inv-chip';
      var t = document.createElement('span');
      t.textContent = labelFor(box, id);
      t.title = t.textContent;
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'cx-inv-x';
      x.setAttribute('data-id', id);
      x.setAttribute('aria-label', 'הסר חשבונית');
      x.textContent = '✕';
      chip.appendChild(t);
      chip.appendChild(x);
      chips.appendChild(chip);
    });
    if (sel) {
      Array.prototype.forEach.call(sel.options, function (o) { if (o.value) o.disabled = ids.indexOf(o.value) >= 0; });
      sel.value = '';
    }
  }
  function changed(box) {
    render(box);
    // הסכום בסיכום והוספת שורה ריקה חדשה מאזינים ל-input על גוף הרשימה.
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.addEventListener('change', function (e) {
    var sel = e.target;
    if (!sel || !sel.matches || !sel.matches('select.cx-inv')) return;
    var box = sel.closest('.cx-inv-box');
    if (!box || !sel.value) return;
    var ids = idsOf(box);
    var multi = box.getAttribute('data-multi') !== '0';
    if (ids.indexOf(sel.value) < 0) ids = multi ? ids.concat(sel.value) : [sel.value];
    setIds(box, ids);
    changed(box);
  });
  document.addEventListener('click', function (e) {
    var x = e.target && e.target.closest ? e.target.closest('.cx-inv-x') : null;
    if (!x) return;
    e.preventDefault();
    var box = x.closest('.cx-inv-box');
    var id = x.getAttribute('data-id');
    setIds(box, idsOf(box).filter(function (v) { return v !== id; }));
    changed(box);
  });
  window.cxInvRender = function (root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('.cx-inv-box'), render);
  };
  window.cxInvLabels = function (row) {
    var box = row && row.querySelector('.cx-inv-box');
    return box ? idsOf(box).map(function (id) { return labelFor(box, id); }) : [];
  };
  function init() {
    window.cxInvRender();
    // הסיכום של הטופס נבנה לפני שהסקריפט הזה נטען — לבנות אותו שוב, עכשיו עם שמות החשבוניות.
    var list = document.querySelector('.cx-list');
    if (list) list.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
