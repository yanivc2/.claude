"use client";

import { useState } from "react";

interface EmployeeOption {
  id: string;
  name: string;
  startDate: string;
}

interface GeneratedDoc {
  type: string;
  title: string;
  html: string;
  noticeDays?: number;
  lastWorkingDay?: string;
}

// טופס יצירת מסמכי סיום העסקה: הזמנה לשימוע ומכתב פיטורין.
// ההודעה המוקדמת מחושבת אוטומטית לפי מועד תחילת העבודה של העובד.
export function TerminationForm({ employees }: { employees: EmployeeOption[] }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const [docType, setDocType] = useState<"HEARING_INVITATION" | "TERMINATION_LETTER">(
    "HEARING_INVITATION",
  );
  const [reason, setReason] = useState("");
  const [hearingDate, setHearingDate] = useState("");
  const [doc, setDoc] = useState<GeneratedDoc | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setDoc(null);
    try {
      const res = await fetch("/api/termination", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, docType, reason, hearingDate: hearingDate || null }),
      });
      const data = await res.json();
      if (res.ok) setDoc(data);
    } finally {
      setLoading(false);
    }
  }

  // גופן 16px בסלולר מונע זום אוטומטי ב-iOS; במסך רחב חוזר ל-14px.
  const inputClass =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-base sm:text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <form onSubmit={generate} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">עובד</span>
          <select className={inputClass} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
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

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">נימוקים</span>
          <textarea
            className={`${inputClass} min-h-28`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            placeholder="פירוט הנימוקים לשקילת/סיום ההעסקה"
          />
        </label>

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
                onClick={() => {
                  const w = window.open("", "_blank");
                  w?.document.write(doc.html);
                  w?.document.close();
                  w?.print();
                }}
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
