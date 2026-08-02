"use client";

import { useState } from "react";
import { FileText, Printer, Plus, Check } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";

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

const REASON_PRESETS = [
  "איחורים",
  "חוסר יעילות בזמן המשמרת",
  "אי הגעה למשמרת ללא אישור מנהל",
  "חשד לגניבה",
  "חוסר זמינות",
  "חוסר שביעות רצון",
  "חשד לצריכת אלכוהול בזמן משמרת",
];

type DocType = "HEARING_INVITATION" | "TERMINATION_LETTER" | "TERMINATION_RESIGNATION";

export function TerminationForm({ employees }: { employees: EmployeeOption[] }) {
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const [companyName, setCompanyName] = useState(employees[0]?.companyName ?? "");
  const [docType, setDocType] = useState<DocType>("HEARING_INVITATION");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [signerName, setSignerName] = useState("");
  const [signerTitle, setSignerTitle] = useState("מנכ\"ל");
  const [reasons, setReasons] = useState<ReasonItem[]>([]);
  const [notes, setNotes] = useState("");
  const [hearingDate, setHearingDate] = useState("");
  const [hearingTime, setHearingTime] = useState("");
  const [location, setLocation] = useState("");
  const [participants, setParticipants] = useState("");
  const [hearingAttended, setHearingAttended] = useState(false);
  const [doc, setDoc] = useState<GeneratedDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function onEmployeeChange(id: string) {
    setEmployeeId(id);
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

  const isHearing = docType === "HEARING_INVITATION";

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
          gender,
          signerName,
          signerTitle,
          reasons,
          notes,
          hearingDate: hearingDate || null,
          hearingTime,
          location,
          participants,
          hearingAttended,
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
    const bar =
      `<div class="noprint" style="position:sticky;top:0;display:flex;flex-wrap:wrap;gap:16px;justify-content:center;background:#0f172a;padding:20px">` +
      `<button onclick="window.print()" style="border:0;border-radius:12px;padding:20px 48px;font-size:24px;font-weight:800;background:#4c51b8;color:#fff;cursor:pointer">🖨️ הדפסה / שמירה</button>` +
      `<button onclick="window.close()" style="border:0;border-radius:12px;padding:20px 48px;font-size:24px;font-weight:800;background:#ef4444;color:#fff;cursor:pointer">✕ סגירה</button>` +
      `</div><style>@media print{.noprint{display:none}}</style>`;
    w.document.write(html.replace("<body>", "<body>" + bar));
    w.document.write(
      `<script>window.onafterprint=function(){window.close()};` +
        `window.onload=function(){setTimeout(function(){window.print()},500)}<\/script>`,
    );
    w.document.close();
  }

  const inputClass =
    "w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2.5 text-base sm:text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <form onSubmit={generate} className="space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm sm:p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">עובד</span>
            <select className={inputClass} value={employeeId} onChange={(e) => onEmployeeChange(e.target.value)}>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">מין (לניסוח)</span>
            <select
              className={inputClass}
              value={gender}
              onChange={(e) => setGender(e.target.value as "male" | "female")}
            >
              <option value="male">זכר</option>
              <option value="female">נקבה</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">שם החברה</span>
          <input
            className={inputClass}
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="שם החברה שיופיע בראש הטופס"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">סוג מסמך</span>
          <select className={inputClass} value={docType} onChange={(e) => setDocType(e.target.value as DocType)}>
            <option value="HEARING_INVITATION">הזמנה לשיחת שימוע</option>
            <option value="TERMINATION_LETTER">מכתב סיום העסקה / פיטורין</option>
            <option value="TERMINATION_RESIGNATION">סיום העסקה כדין מתפטר/ת</option>
          </select>
        </label>

        {isHearing && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">מועד השימוע</span>
              <input
                type="date"
                className={inputClass}
                value={hearingDate}
                onChange={(e) => setHearingDate(e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">שעת השימוע</span>
              <input
                type="time"
                className={inputClass}
                value={hearingTime}
                onChange={(e) => setHearingTime(e.target.value)}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">מקום השימוע</span>
              <input
                className={inputClass}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="לדוגמה: סניף הגדוד העברי 52, ראשון לציון"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">משתתפים בשימוע</span>
              <input
                className={inputClass}
                value={participants}
                onChange={(e) => setParticipants(e.target.value)}
                placeholder="לדוגמה: הבעלים יניב כהן"
              />
            </label>
          </div>
        )}

        {!isHearing && (
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">התייצבות לשימוע</span>
            <div className="flex flex-wrap gap-4 text-sm text-slate-700 dark:text-slate-200">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="attended"
                  checked={!hearingAttended}
                  onChange={() => setHearingAttended(false)}
                />
                השימוע התקיים ללא נוכחות העובד
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="attended"
                  checked={hearingAttended}
                  onChange={() => setHearingAttended(true)}
                />
                העובד התייצב לשימוע
              </label>
            </div>
          </div>
        )}

        {/* רובריקות נימוקים ללחיצה */}
        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">נימוקים — לחצ/י להוספה</span>
          <div className="flex flex-wrap gap-2">
            {REASON_PRESETS.map((title) => {
              const added = reasons.some((r) => r.title === title);
              return (
                <button
                  key={title}
                  type="button"
                  onClick={() => addReason(title)}
                  disabled={added}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                    added
                      ? "cursor-default border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-400"
                      : "border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/25"
                  }`}
                >
                  {added ? <Check size={13} strokeWidth={2.6} /> : <Plus size={13} strokeWidth={2.6} />}
                  {title}
                </button>
              );
            })}
          </div>
        </div>

        {reasons.length > 0 && (
          <div className="space-y-2">
            {reasons.map((r, i) => (
              <div key={r.title} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.title}</span>
                  <button type="button" onClick={() => removeReason(i)} className="text-xs text-red-600 dark:text-red-400 hover:underline">
                    הסרה
                  </button>
                </div>
                <textarea
                  className={`${inputClass} min-h-16`}
                  value={r.detail}
                  onChange={(e) => setDetail(i, e.target.value)}
                  placeholder="פירוט נוסף (אופציונלי) — תאריכים, מקרים ספציפיים"
                />
              </div>
            ))}
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">מלל חופשי נוסף (אופציונלי)</span>
          <textarea
            className={`${inputClass} min-h-20`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="פסקה נוספת שתתווסף לטופס"
          />
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">שם החותם</span>
            <input
              className={inputClass}
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              placeholder="לדוגמה: יניב כהן"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">תפקיד החותם</span>
            <input className={inputClass} value={signerTitle} onChange={(e) => setSignerTitle(e.target.value)} />
          </label>
        </div>

        {error && <p className="rounded-lg bg-red-50 dark:bg-red-500/15 px-4 py-3 text-sm text-red-700 dark:text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading || !employeeId}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-3 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105 disabled:opacity-60 sm:w-auto"
        >
          <FileText size={16} />
          {loading ? "מפיק מסמך..." : "הפקת מסמך"}
        </button>
      </form>

      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm sm:p-6">
        {doc ? (
          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-bold text-slate-800 dark:text-slate-100">{doc.title}</h3>
              <button
                onClick={() => printDoc(doc.html)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 transition hover:border-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10"
              >
                <Printer size={14} />
                הדפסה / PDF
              </button>
            </div>
            {doc.noticeDays !== undefined && (
              <p className="mb-3 rounded-lg bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                הודעה מוקדמת מחושבת: <strong>{doc.noticeDays} ימים</strong>
                {doc.lastWorkingDay &&
                  ` · יום עבודה אחרון: ${new Intl.DateTimeFormat("he-IL").format(new Date(doc.lastWorkingDay))}`}
              </p>
            )}
            <div
              className="prose prose-sm max-w-none rounded-lg border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-4"
              dangerouslySetInnerHTML={{ __html: doc.html }}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              bare
              icon={FileText}
              title="המסמך שייווצר יוצג כאן"
              subtitle="בחר/י עובד, סוג מסמך ונימוקים — ולחצ/י על ״הפקת מסמך״."
            />
          </div>
        )}
      </div>
    </div>
  );
}
