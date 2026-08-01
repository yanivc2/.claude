"use client";

import { useEffect, useState } from "react";

// בורר תאריך מבוסס שלושה תפריטי בחירה (יום / חודש / שנה). באייפון ובאנדרואיד
// כל <select> מוצג כגלגל בורר מקורי — נוח בהרבה מלוח שנה. הערך הוא מחרוזת
// ISO בפורמט YYYY-MM-DD (זהה ל-<input type="date"> שהוחלף), כדי לא לשנות את
// שאר הטופס. בחירה חלקית נשמרת פנימית עד להשלמת שלושת החלקים.

const MONTHS = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

const selectClass =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-2.5 text-base sm:text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

const pad = (v: string) => String(Number(v)).padStart(2, "0");
const compose = (p: { y: string; m: string; d: string }) =>
  p.y && p.m && p.d ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : "";

function parse(v: string): { y: string; m: string; d: string } {
  const [y, m, d] = v ? v.split("-") : ["", "", ""];
  return { y: y || "", m: m ? String(Number(m)) : "", d: d ? String(Number(d)) : "" };
}

export function DateWheel({
  value,
  onChange,
  fromYear,
  toYear,
}: {
  value: string;
  onChange: (v: string) => void;
  fromYear?: number;
  toYear?: number;
}) {
  const currentYear = new Date().getFullYear();
  const maxYear = toYear ?? currentYear + 1;
  const minYear = fromYear ?? 1940;

  const [parts, setParts] = useState(() => parse(value));
  const composed = compose(parts);

  // סנכרון מערך חיצוני מלא (מילוי-מראש/עריכה). התעלמות מ-"" חיצוני כדי לא
  // למחוק בחירה חלקית שהמשתמש כבר עשה.
  useEffect(() => {
    if (value && value !== composed) setParts(parse(value));
  }, [value, composed]);

  const years: number[] = [];
  for (let i = maxYear; i >= minYear; i--) years.push(i);
  const days: number[] = [];
  for (let i = 1; i <= 31; i++) days.push(i);

  function update(part: "d" | "m" | "y", val: string) {
    const next = { ...parts, [part]: val };
    setParts(next);
    onChange(compose(next));
  }

  return (
    <div className="grid grid-cols-3 gap-2" dir="rtl">
      <select className={selectClass} value={parts.d} onChange={(e) => update("d", e.target.value)} aria-label="יום">
        <option value="">יום</option>
        {days.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <select className={selectClass} value={parts.m} onChange={(e) => update("m", e.target.value)} aria-label="חודש">
        <option value="">חודש</option>
        {MONTHS.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </select>
      <select className={selectClass} value={parts.y} onChange={(e) => update("y", e.target.value)} aria-label="שנה">
        <option value="">שנה</option>
        {years.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  );
}
