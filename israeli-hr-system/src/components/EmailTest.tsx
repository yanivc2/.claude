"use client";

import { useState } from "react";
import { MailCheck } from "lucide-react";

// כפתור בדיקת מייל — שולח מייל ניסיון לכתובת של הבעלים ומדווח על התוצאה.
export function EmailTest() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings/test-email", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult({ ok: true, msg: `נשלח מייל ניסיון אל ${body.to}. בדוק/י את תיבת הדואר (וגם ספאם).` });
      } else {
        setResult({ ok: false, msg: body.error ?? "השליחה נכשלה." });
      }
    } catch {
      setResult({ ok: false, msg: "שגיאת רשת." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <MailCheck size={20} />
        </span>
        <div>
          <h2 className="text-lg font-bold leading-tight text-slate-800 dark:text-slate-100">בדיקת שליחת מייל</h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            שליחת מייל ניסיון לכתובת שלך, לבדיקת החיבור ל-Resend.
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105 disabled:opacity-60"
      >
        <MailCheck size={16} />
        {busy ? "שולח…" : "שליחת מייל ניסיון"}
      </button>

      {result && (
        <p
          className={`mt-3 rounded-lg px-4 py-2 text-sm ${
            result.ok
              ? "bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-400"
              : "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400"
          }`}
        >
          {result.msg}
        </p>
      )}
    </section>
  );
}
