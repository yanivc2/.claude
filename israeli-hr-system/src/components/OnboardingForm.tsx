"use client";

import { useState } from "react";
import { SignaturePad } from "./SignaturePad";

// ─────────────────────────────────────────────────────────────────────────
// טופס קליטת עובד: כולל טופס 101 דיגיטלי, העלאת ספח ת.ז, וחתימה דיגיטלית
// על הסכם העבודה. כל הטקסטים בעברית ובפריסת RTL.
// ─────────────────────────────────────────────────────────────────────────

interface FormState {
  // פרטים אישיים
  firstName: string;
  lastName: string;
  nationalId: string;
  email: string;
  phone: string;
  address: string;
  birthDate: string;
  // פרטי העסקה
  startDate: string;
  jobTitle: string;
  department: string;
  monthlySalary: string;
  hasActivePension: boolean;
  // טופס 101
  taxYear: string;
  maritalStatus: string;
  numberOfChildren: string;
  isResidentOfIsrael: boolean;
  hasOtherIncome: boolean;
  requestsCredits: boolean;
}

const EMPTY: FormState = {
  firstName: "",
  lastName: "",
  nationalId: "",
  email: "",
  phone: "",
  address: "",
  birthDate: "",
  startDate: "",
  jobTitle: "",
  department: "",
  monthlySalary: "",
  hasActivePension: false,
  taxYear: String(new Date().getFullYear()),
  maritalStatus: "רווק/ה",
  numberOfChildren: "0",
  isResidentOfIsrael: true,
  hasOtherIncome: false,
  requestsCredits: false,
};

// מחשב גיל מתאריך לידה (לתצוגה בלבד).
function ageFromBirthDate(iso: string): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

// גופן 16px בסלולר (text-base) מונע זום אוטומטי ב-iOS בעת מיקוד בשדה; במסך רחב חוזר ל-14px.
const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-base sm:text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

interface OnboardingFormProps {
  // נתיב ההגשה: ברירת מחדל הוא מסלול ה-HR; הפורטל הציבורי מעביר נתיב מבוסס-טוקן.
  endpoint?: string;
  // מילוי מוקדם (למשל שם/דוא״ל שהוזנו ע"י HR בעת יצירת הקישור).
  defaults?: Partial<FormState>;
  // הודעת הצלחה מותאמת (למשל בפורטל הציבורי).
  doneMessage?: string;
  // הסכם עבודה שה-HR צירף — מוצג לעובד לקריאה/הורדה לפני החתימה.
  agreement?: { fileName: string; dataUrl: string; mimeType?: string };
}

// בריחת תווים לצורך הזרקה בטוחה ל-HTML של חלון ההדפסה.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function OnboardingForm({
  endpoint = "/api/onboarding",
  defaults,
  doneMessage,
  agreement,
}: OnboardingFormProps = {}) {
  const [form, setForm] = useState<FormState>({ ...EMPTY, ...defaults });
  const [idFile, setIdFile] = useState<File | null>(null);
  const [contractSignature, setContractSignature] = useState<string | null>(null);
  const [form101Signature, setForm101Signature] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setMessage("");

    if (!contractSignature) {
      setStatus("error");
      setMessage("נדרשת חתימה על הסכם העבודה כדי להשלים את הקליטה.");
      return;
    }

    try {
      const idAttachment = idFile
        ? { fileName: idFile.name, mimeType: idFile.type, data: await fileToDataUrl(idFile) }
        : null;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          numberOfChildren: Number(form.numberOfChildren),
          monthlySalary: form.monthlySalary ? Number(form.monthlySalary) : null,
          taxYear: Number(form.taxYear),
          idAttachment,
          contractSignature,
          form101Signature,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "אירעה שגיאה בשמירת הטופס");
      }

      setStatus("done");
      setMessage(
        doneMessage ??
          "הקליטה הושלמה בהצלחה! סקרי שביעות רצון תוזמנו אוטומטית ל-3/15/30 ימים.",
      );
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "שגיאה לא צפויה");
    }
  }

  // מפיק מסמך אחד להדפסה/שמירה: ההסכם + פרטי העובד + החתימה.
  // המשתמש יכול לבחור "שמירה כ-PDF" מתוך חלון ההדפסה של הדפדפן.
  function printSignedAgreement() {
    if (!agreement) return;
    const w = window.open("", "_blank");
    if (!w) {
      alert("החלון נחסם. אנא אפשר/י חלונות קופצים ונסה/י שוב.");
      return;
    }
    const name = escapeHtml(`${form.firstName} ${form.lastName}`.trim() || "—");
    const nid = escapeHtml(form.nationalId || "—");
    const date = new Date().toLocaleDateString("he-IL");
    const isPdf = (agreement.mimeType ?? "").includes("pdf");
    const agreementHtml = isPdf
      ? `<embed src="${agreement.dataUrl}" type="application/pdf" style="width:100%;height:80vh;border:1px solid #ddd" />`
      : `<img src="${agreement.dataUrl}" style="max-width:100%;border:1px solid #ddd" />`;
    const sigHtml = contractSignature
      ? `<img src="${contractSignature}" style="height:110px" alt="חתימה" />`
      : "<p>ללא חתימה</p>";

    w.document.write(
      `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8" />` +
        `<title>הסכם עבודה חתום — ${name}</title>` +
        `<style>body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:24px;line-height:1.5}` +
        `h1{font-size:20px}h2{font-size:15px;margin-top:24px}.meta{font-size:13px;color:#475569}` +
        `.sig{margin-top:24px;border-top:1px solid #cbd5e1;padding-top:12px}</style></head><body>` +
        `<h1>הסכם עבודה</h1>` +
        `<p class="meta">עובד/ת: <strong>${name}</strong> · ת.ז: ${nid} · תאריך: ${date}</p>` +
        `<h2>ההסכם:</h2>${agreementHtml}` +
        `<div class="sig"><p>חתימת העובד/ת (מאשר/ת את תנאי ההסכם):</p>${sigHtml}` +
        `<p class="meta">נחתם בתאריך ${date}</p></div>` +
        `<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>` +
        `</body></html>`,
    );
    w.document.close();
  }

  // מפיק מסמך טופס 101 להדפסה/שמירה: כל השדות + החתימה על טופס 101.
  function printForm101() {
    const w = window.open("", "_blank");
    if (!w) {
      alert("החלון נחסם. אנא אפשר/י חלונות קופצים ונסה/י שוב.");
      return;
    }
    const g = (v: string) => escapeHtml(v || "—");
    const yesNo = (b: boolean) => (b ? "כן" : "לא");
    const fullName = g(`${form.firstName} ${form.lastName}`.trim());
    const date = new Date().toLocaleDateString("he-IL");
    const sig = form101Signature
      ? `<img src="${form101Signature}" style="height:110px" alt="חתימה" />`
      : "<p>ללא חתימה</p>";
    const rows: Array<[string, string]> = [
      ["שם מלא", fullName],
      ["תעודת זהות", g(form.nationalId)],
      ["תאריך לידה", g(form.birthDate)],
      ["דוא״ל", g(form.email)],
      ["טלפון", g(form.phone)],
      ["כתובת", g(form.address)],
      ["שנת מס", g(form.taxYear)],
      ["מצב משפחתי", g(form.maritalStatus)],
      ["מספר ילדים", g(form.numberOfChildren)],
      ["תושב/ת ישראל", yesNo(form.isResidentOfIsrael)],
      ["הכנסה נוספת ממעסיק אחר", yesNo(form.hasOtherIncome)],
      ["בקשה לנקודות זיכוי", yesNo(form.requestsCredits)],
    ];
    const tableRows = rows
      .map(
        ([k, v]) =>
          `<tr><td style="font-weight:600;width:40%">${k}</td><td>${v}</td></tr>`,
      )
      .join("");

    w.document.write(
      `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8" />` +
        `<title>טופס 101 — ${fullName}</title>` +
        `<style>body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:24px;line-height:1.5}` +
        `h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}` +
        `td{border:1px solid #cbd5e1;padding:6px 10px;text-align:right}` +
        `.sig{margin-top:24px;border-top:1px solid #cbd5e1;padding-top:12px}.meta{font-size:13px;color:#475569}</style>` +
        `</head><body>` +
        `<h1>טופס 101 — כרטיס עובד לצורכי מס</h1>` +
        `<p class="meta">תאריך: ${date}</p>` +
        `<table>${tableRows}</table>` +
        `<div class="sig"><p>חתימת העובד/ת:</p>${sig}<p class="meta">נחתם בתאריך ${date}</p></div>` +
        `<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>` +
        `</body></html>`,
    );
    w.document.close();
  }

  if (status === "done") {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-6 text-green-800">
        <p className="text-lg font-semibold">✓ {message}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={printForm101}
            className="rounded-lg border border-green-300 bg-white px-4 py-2 text-sm font-semibold text-green-800 transition hover:bg-green-100"
          >
            🖨️ הדפסה / שמירת טופס 101
          </button>
          {agreement && contractSignature && (
            <button
              type="button"
              onClick={printSignedAgreement}
              className="rounded-lg border border-green-300 bg-white px-4 py-2 text-sm font-semibold text-green-800 transition hover:bg-green-100"
            >
              🖨️ הדפסה / שמירת ההסכם החתום
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* פרטים אישיים */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-800">פרטים אישיים</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="שם פרטי">
            <input
              className={inputClass}
              required
              value={form.firstName}
              onChange={(e) => set("firstName", e.target.value)}
            />
          </Field>
          <Field label="שם משפחה">
            <input
              className={inputClass}
              required
              value={form.lastName}
              onChange={(e) => set("lastName", e.target.value)}
            />
          </Field>
          <Field label="תעודת זהות">
            <input
              className={inputClass}
              required
              inputMode="numeric"
              maxLength={9}
              value={form.nationalId}
              onChange={(e) => set("nationalId", e.target.value)}
            />
          </Field>
          <Field label="דוא״ל">
            <input
              className={inputClass}
              type="email"
              required
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </Field>
          <Field label="טלפון">
            <input
              className={inputClass}
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
          </Field>
          <Field label="כתובת">
            <input
              className={inputClass}
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
            />
          </Field>
          <Field
            label={
              ageFromBirthDate(form.birthDate) !== null
                ? `תאריך לידה (גיל: ${ageFromBirthDate(form.birthDate)})`
                : "תאריך לידה"
            }
          >
            <input
              className={inputClass}
              type="date"
              value={form.birthDate}
              onChange={(e) => set("birthDate", e.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* פרטי העסקה */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-800">פרטי העסקה</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="מועד תחילת עבודה">
            <input
              className={inputClass}
              type="date"
              required
              value={form.startDate}
              onChange={(e) => set("startDate", e.target.value)}
            />
          </Field>
          <Field label="תפקיד">
            <input
              className={inputClass}
              value={form.jobTitle}
              onChange={(e) => set("jobTitle", e.target.value)}
            />
          </Field>
          <Field label="מחלקה">
            <input
              className={inputClass}
              value={form.department}
              onChange={(e) => set("department", e.target.value)}
            />
          </Field>
          <Field label="שכר חודשי (₪)">
            <input
              className={inputClass}
              type="number"
              inputMode="numeric"
              value={form.monthlySalary}
              onChange={(e) => set("monthlySalary", e.target.value)}
            />
          </Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.hasActivePension}
            onChange={(e) => set("hasActivePension", e.target.checked)}
          />
          קיים הסדר פנסיוני פעיל
        </label>
      </section>

      {/* טופס 101 */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 className="mb-1 text-lg font-semibold text-slate-800">טופס 101</h2>
        <p className="mb-4 text-sm text-slate-500">
          כרטיס עובד לצורכי ניכוי מס הכנסה במקור.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="שנת המס">
            <input
              className={inputClass}
              type="number"
              value={form.taxYear}
              onChange={(e) => set("taxYear", e.target.value)}
            />
          </Field>
          <Field label="מצב משפחתי">
            <select
              className={inputClass}
              value={form.maritalStatus}
              onChange={(e) => set("maritalStatus", e.target.value)}
            >
              <option>רווק/ה</option>
              <option>נשוי/אה</option>
              <option>גרוש/ה</option>
              <option>אלמן/ה</option>
            </select>
          </Field>
          <Field label="מספר ילדים">
            <input
              className={inputClass}
              type="number"
              min={0}
              value={form.numberOfChildren}
              onChange={(e) => set("numberOfChildren", e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4 space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.isResidentOfIsrael}
              onChange={(e) => set("isResidentOfIsrael", e.target.checked)}
            />
            תושב/ת ישראל
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.hasOtherIncome}
              onChange={(e) => set("hasOtherIncome", e.target.checked)}
            />
            קיימת הכנסה נוספת ממעסיק אחר
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.requestsCredits}
              onChange={(e) => set("requestsCredits", e.target.checked)}
            />
            בקשה לנקודות זיכוי
          </label>
        </div>

        {/* העלאת ספח ת.ז */}
        <div className="mt-4">
          <Field label="העלאת ספח תעודת זהות">
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setIdFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-600 file:ml-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700"
            />
          </Field>
          {idFile && <p className="mt-1 text-xs text-green-700">נבחר: {idFile.name}</p>}
        </div>

        {/* חתימה על טופס 101 */}
        <div className="mt-4">
          <SignaturePad label="חתימה על טופס 101" onChange={setForm101Signature} />
        </div>

        <button
          type="button"
          onClick={printForm101}
          className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-100"
        >
          🖨️ הדפסה / שמירת טופס 101
        </button>
      </section>

      {/* חתימה על הסכם העבודה */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 className="mb-4 text-lg font-semibold text-slate-800">הסכם עבודה</h2>
        <p className="mb-4 text-sm text-slate-500">
          אנא קרא/י את הסכם העבודה וחתום/מי במקום המיועד. החתימה מהווה אישור לתנאי
          ההעסקה.
        </p>

        {/* הסכם עבודה שצורף ע"י המעסיק — מוצג מוטמע לקריאה, עם הורדה */}
        {agreement && (
          <div className="mb-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-700">
                📄 הסכם העבודה: {agreement.fileName}
              </span>
              <a
                href={agreement.dataUrl}
                download={agreement.fileName}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 transition hover:bg-slate-50"
              >
                הורדה
              </a>
            </div>
            {(agreement.mimeType ?? "").includes("pdf") ? (
              <iframe
                src={agreement.dataUrl}
                title="הסכם עבודה"
                className="h-96 w-full rounded-lg border border-slate-200"
              />
            ) : (
              <img
                src={agreement.dataUrl}
                alt="הסכם עבודה"
                className="max-h-96 w-full rounded-lg border border-slate-200 object-contain"
              />
            )}
          </div>
        )}

        <SignaturePad label="חתימה על הסכם העבודה (חובה)" onChange={setContractSignature} />

        {agreement && (
          <button
            type="button"
            onClick={printSignedAgreement}
            className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-100"
          >
            🖨️ הדפסה / שמירת ההסכם עם החתימה
          </button>
        )}
      </section>

      {status === "error" && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{message}</p>
      )}

      <button
        type="submit"
        disabled={status === "saving"}
        className="w-full rounded-lg bg-brand-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60 sm:w-auto"
      >
        {status === "saving" ? "שומר..." : "השלמת קליטה"}
      </button>
    </form>
  );
}
