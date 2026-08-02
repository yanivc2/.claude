"use client";

import { useState } from "react";

const inputClass =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2.5 text-base outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";
const primaryBtn =
  "w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60";

type Stage = "request" | "confirm" | "emergency";

// מסלול "שכחתי סיסמה": בקשת קוד למייל → קוד + סיסמה חדשה. אם המייל אינו מוגדר
// בשרת — נפילה לאיפוס חירום באמצעות סוד סביבה (OWNER_RESET_SECRET).
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [stage, setStage] = useState<Stage>("request");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/forgot-password/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "שגיאה");
      if (d.emailSent) {
        setMaskedEmail(d.email ?? "");
        setStage("confirm");
      } else {
        // אין מייל מוגדר — מפנים לאיפוס חירום.
        setStage("emergency");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  async function confirmReset(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/forgot-password/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, code, newPassword }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "שגיאה");
      finishOk();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  async function emergencyReset(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/emergency-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, newPassword }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "שגיאה");
      finishOk();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  function finishOk() {
    setInfo("הסיסמה אופסה בהצלחה! חוזרים למסך הכניסה…");
    setTimeout(onBack, 1600);
  }

  return (
    <div>
      <h2 className="mb-1 text-lg font-bold text-slate-800 dark:text-slate-100">איפוס סיסמה</h2>

      {stage === "request" && (
        <form onSubmit={requestCode} className="space-y-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            הזן/י שם משתמש, ונשלח קוד איפוס למייל הרשום בחשבון.
          </p>
          <input
            className={inputClass}
            placeholder="שם משתמש"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-400">{error}</p>}
          <button type="submit" disabled={busy} className={primaryBtn}>
            {busy ? "שולח…" : "שליחת קוד למייל"}
          </button>
        </form>
      )}

      {stage === "confirm" && (
        <form onSubmit={confirmReset} className="space-y-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            נשלח קוד לכתובת {maskedEmail}. הזן/י את הקוד וסיסמה חדשה.
          </p>
          <input
            className={inputClass}
            placeholder="קוד מהמייל (6 ספרות)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            required
          />
          <input
            className={inputClass}
            placeholder="סיסמה חדשה (לפחות 6 תווים)"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-400">{error}</p>}
          {info && <p className="rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700 dark:bg-green-500/15 dark:text-green-400">{info}</p>}
          <button type="submit" disabled={busy} className={primaryBtn}>
            {busy ? "מאפס…" : "איפוס סיסמה"}
          </button>
        </form>
      )}

      {stage === "emergency" && (
        <form onSubmit={emergencyReset} className="space-y-3">
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            שליחת מייל אינה מוגדרת בשרת, לכן משתמשים ב<strong>איפוס חירום</strong>: יש להגדיר
            ב-Vercel משתנה בשם <code dir="ltr">OWNER_RESET_SECRET</code> (ערך לבחירתך), לבצע
            Redeploy, ואז להזין כאן את אותו ערך וסיסמה חדשה.
          </div>
          <input
            className={inputClass}
            placeholder="סוד החירום (OWNER_RESET_SECRET)"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            dir="ltr"
            required
          />
          <input
            className={inputClass}
            placeholder="סיסמה חדשה (לפחות 6 תווים)"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/15 dark:text-red-400">{error}</p>}
          {info && <p className="rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700 dark:bg-green-500/15 dark:text-green-400">{info}</p>}
          <button type="submit" disabled={busy} className={primaryBtn}>
            {busy ? "מאפס…" : "איפוס חירום"}
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={onBack}
        className="mt-3 w-full text-center text-sm text-slate-500 underline transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        חזרה למסך הכניסה
      </button>
    </div>
  );
}
