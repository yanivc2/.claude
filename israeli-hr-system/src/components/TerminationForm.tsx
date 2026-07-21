"use client";

import { useState } from "react";

interface EmployeeOption {
  id: string;
  name: string;
  startDate: string;
  companyName?: string;
}

interface GeneratedDoc {
  type: string;
  title: string;
  html: string;
  noticeDays?: number;
  lastWorkingDay?: string;
}

interface ReasonItem {
  title: string;
  detail: string;
}

// רובריקות מוכנות ללחיצה — נימוקים נפוצים לשימוע/סיום העסקה.
const REASON_PRESETS = [
  "איחורים",
  "חוסר יעילות בזמן המשמרת",
  "אי הגעה למשמרת ללא אישור מנהל",
  "חשד לגניבה",
  "חוסר זמינות",
];

// טופס יצירת מסמכי סיום העסקה: הזמנה לשימוע ומכתב פיטורין.
// ההודעה המוקדמת מחושבת אוטומטית לפי מועד תחילת העבודה של העובד.
export function TerminationForm({ employees }: { employees: EmployeeOption[] }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const [companyName, setCompanyName] = useState(employees[0]?.companyName ?? "");
  const [docType, setDocType] = useState<"HEARING_INVITATION" | "TERMINATION_LETTER">(
    "HEARING_INVITATION",
  );
  const [reasons, setReasons] = useState<ReasonItem[]>([]);
  const [notes, setNotes] = useState("");
  const [hearingDate, setHearingDate] = useState("");
  const [doc, setDoc] = useState<GeneratedDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function onEmployeeChange(id: string) {
    setEmployeeId(id);
    // מילוי אוטומטי של שם החברה מתוך הקישור שדרכו נקלט העובד (ניתן לעריכה).
    const emp = employees.find((e) => e.id === id);
    setCompanyName(emp?.companyName ?? "");
  }

  function addReason(title: string) {
    setReasons((prev) => (prev.some((r) => r.title === title) ? prev : [...prev, { title, detail: "" }]));
  }
  function setDetail(index: number, detail: string) {
    setReasons((prev) => prev.map((r, i) => (i === index ? { ...r, detail } : r)));
  }
  function removeReason(index: number) {
    setReasons((prev) => prev.filter((_, i) => i !== index));
  }

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (reasons.length === 0 && !notes.trim()) {
      setError("יש לבחור נימוק אחד לפחות (רובריקה) או להוסיף מלל.");
      return;
    }
    setLoading(true);
    setDoc(null);
    try {
      const res = await fetch("/api/termination", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId,
          docType,
          companyName,
          reasons,
          notes,
          hearingDate: hearingDate || null,
        }),
      });
      const data = await res.json();
      if (res.ok) setDoc(data);
      else setError(data.error ?? "שגיאה בהפקת המסמך");
    } finally {
      setLoading(false);
    }
  }

  function printDoc(html: string) {
    const w = window.open("", "_blank");
    if (!w) {
      alert("החלון נחסם. אנא אפשר/י חלונות קופצים ונסה/י שוב.");
      return;
    }
    w.document.write(html);
    // סגירה אוטומטית אחרי ההדפסה כדי שניתן יהיה לצאת מהמסמך.
    w.document.write(
      `<script>window.onafterprint=function(){window.close()};` +
        `window.onload=function(){setTimeout(function(){window.print()},500)}<\/script>`,
    );
    w.document.close();
  }

  const inputClass =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-base sm:text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <form onSubmit={generate} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">עובד</span>
          <select
            className={inputClass}
            value={employeeId}
            onChange={(e) => onEmployeeChange(e.target.value)}
          >
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">שם החברה</span>
          <input
            className={inputClass}
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="שם החברה שיופיע בראש הטופס"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">סוג מסמך</span>
          <select
            className={inputClass}
            value={docType}
            onChange={(e) => setDocType(e.target.value as typeof docType)}
          >
            <option value="HEARING_INVITATION">הזמנה לשימוע</option>
            <option value="TERMINATION_LETTER">מכתב סיום העסקה / פיטורין</option>
          </select>
        </label>

        {docType === "HEARING_INVITATION" && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">מועד השימוע</span>
            <input
              type="date"
              className={inputClass}
              value={hearingDate}
              onChange={(e) => setHearingDate(e.target.value)}
              required
            />
          </label>
        )}

        {/* רובריקות נימוקים ללחיצה */}
        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700">
            נימוקים — לחצ/י להוספה לטופס
          </span>
          <div className="flex flex-wrap gap-2">
            {REASON_PRESETS.map((title) => {
              const added = reasons.some((r) => r.title === title);
              return (
                <button
                  key={title}
                  type="button"
                  onClick={() => addReason(title)}
                  disabled={added}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    added
                      ? "cursor-default border-slate-200 bg-slate-100 text-slate-400"
                      : "border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100"
                  }`}
                >
                  {added ? `✓ ${title}` : `+ ${title}`}
                </button>
              );
            })}
          </div>
        </div>

        {/* נימוקים שנוספו — עם פירוט אופציונלי */}
        {reasons.length > 0 && (
          <div className="space-y-2">
            {reasons.map((r, i) => (
              <div key={r.title} className="rounded-lg border border-slate-200 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-800">{r.title}</span>
                  <button
                    type="button"
                    onClick={() => removeReason(i)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    הסרה
                  </button>
                </div>
                <textarea
                  className={`${inputClass} min-h-16`}
                  value={r.detail}
                  onChange={(e) => setDetail(i, e.target.value)}
                  placeholder="פירוט נוסף (אופציונלי) — לדוגמה תאריכים, מקרים ספציפיים"
                />
              </div>
            ))}
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">מלל חופשי נוסף (אופציונלי)</span>
          <textarea
            className={`${inputClass} min-h-20`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="הערות נוספות שיתווספו לטופס"
          />
        </label>

        {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={loading || !employeeId}
          className="w-full rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60 sm:w-auto"
        >
          {loading ? "מפיק מסמך..." : "הפקת מסמך"}
        </button>
      </form>

      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        {doc ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800">{doc.title}</h3>
              <button
                onClick={() => printDoc(doc.html)}
                className="text-sm text-brand-600 hover:underline"
              >
                הדפסה / PDF
              </button>
            </div>
            {doc.noticeDays !== undefined && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                הודעה מוקדמת מחושבת: <strong>{doc.noticeDays} ימים</strong>
                {doc.lastWorkingDay &&
                  ` · יום עבודה אחרון: ${new Intl.DateTimeFormat("he-IL").format(
                    new Date(doc.lastWorkingDay),
                  )}`}
              </p>
            )}
            <div
              className="prose prose-sm max-w-none rounded-lg border border-slate-100 bg-slate-50 p-4"
              dangerouslySetInnerHTML={{ __html: doc.html }}
            />
          </div>
        ) : (
          <p className="flex h-full items-center justify-center text-sm text-slate-400">
            המסמך שייווצר יוצג כאן.
          </p>
        )}
      </div>
    </div>
  );
}
