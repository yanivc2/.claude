"use client";

import { useState } from "react";
import { KeyRound, CheckCircle2 } from "lucide-react";

const inputClass =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2.5 text-base outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

export function ChangePassword() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"form" | "confirm" | "done">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  async function requestChange(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPass) {
      setError("הסיסמה החדשה ואימותה אינם תואמים.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/change-password/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "שגיאה");
      setPhase("confirm");
      setInfo(
        data.emailSent
          ? `שלחנו קוד אישור למייל ${data.email}. הזן/י אותו כאן.`
          : `שירות המייל אינו מוגדר עדיין. קוד האישור שלך: ${data.code}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  async function confirmChange(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/change-password/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "שגיאה");
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "done") {
    return (
      <div className="flex max-w-md items-center gap-3 rounded-2xl border border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/15 p-6 shadow-sm">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-green-100 text-green-700 dark:bg-green-500/25 dark:text-green-300">
          <CheckCircle2 size={22} />
        </span>
        <p className="text-lg font-semibold text-green-800 dark:text-green-300">הסיסמה שונתה בהצלחה.</p>
      </div>
    );
  }

  return (
    <div className="max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <KeyRound size={20} />
        </span>
        <div>
          <h2 className="text-lg font-bold leading-tight text-slate-800 dark:text-slate-100">שינוי סיסמה</h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">אימות דו־שלבי בקוד למייל.</p>
        </div>
      </div>

      {phase === "form" ? (
        <form onSubmit={requestChange} className="space-y-3">
          <input
            className={inputClass}
            type="password"
            placeholder="סיסמה נוכחית"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <input
            className={inputClass}
            type="password"
            placeholder="סיסמה חדשה (לפחות 6 תווים)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <input
            className={inputClass}
            type="password"
            placeholder="אימות סיסמה חדשה"
            value={confirmPass}
            onChange={(e) => setConfirmPass(e.target.value)}
            autoComplete="new-password"
            required
          />
          {error && <p className="rounded-lg bg-red-50 dark:bg-red-500/15 px-4 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-3 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105 disabled:opacity-60 sm:w-auto"
          >
            {busy ? "שולח קוד..." : "שליחת קוד אישור למייל"}
          </button>
        </form>
      ) : (
        <form onSubmit={confirmChange} className="space-y-3">
          {info && <p className="rounded-lg bg-blue-50 dark:bg-blue-500/15 px-4 py-2 text-sm text-blue-800 dark:text-blue-300">{info}</p>}
          <input
            className={inputClass}
            inputMode="numeric"
            placeholder="קוד אישור בן 6 ספרות"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          {error && <p className="rounded-lg bg-red-50 dark:bg-red-500/15 px-4 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-3 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105 disabled:opacity-60 sm:w-auto"
          >
            {busy ? "מאשר..." : "אישור ושינוי הסיסמה"}
          </button>
        </form>
      )}
    </div>
  );
}
