"use client";

import { useState } from "react";
import { KeyRound, Copy, Check, Loader2, RefreshCw } from "lucide-react";

// ניהול גישת עובד (self-service): יצירה/איפוס סיסמה. הסיסמה מוצגת פעם אחת
// לשיתוף עם העובד (לא נשמרת בטקסט גלוי במערכת).
export function EmployeeAccess({
  employeeId,
  email,
  hasAccess,
}: {
  employeeId: string;
  email: string;
  hasAccess: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [granted, setGranted] = useState(hasAccess);

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/employees/${employeeId}/access`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "יצירת הגישה נכשלה");
      setCreds({ email: d.email, password: d.password });
      setGranted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!creds) return;
    const text = `כניסה לאפליקציית העובדים\nדוא״ל: ${creds.email}\nסיסמה: ${creds.password}`;
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {granted
          ? "לעובד/ת יש גישה לאפליקציית ה-self-service. ניתן לאפס סיסמה במידת הצורך."
          : "יצירת גישה לאפליקציית העובד (משימות, טופס 101, נהלים וסרטונים). הכניסה מתבצעת עם הדוא״ל וסיסמה שתופק."}
      </p>

      {creds && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300">
            הפרטים מוצגים פעם אחת — יש להעביר אותם לעובד/ת כעת
          </p>
          <div className="mt-2 space-y-1 font-mono text-sm text-slate-800 dark:text-slate-100" dir="ltr">
            <div>{creds.email}</div>
            <div className="font-bold">{creds.password}</div>
          </div>
          <button
            type="button"
            onClick={copy}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-700"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "הועתק" : "העתקת פרטי הכניסה"}
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-400">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={generate}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : granted ? <RefreshCw size={16} /> : <KeyRound size={16} />}
        {granted ? "איפוס סיסמה" : "יצירת גישת עובד"}
      </button>
      <p className="text-xs text-slate-400" dir="ltr">
        {email}
      </p>
    </div>
  );
}
