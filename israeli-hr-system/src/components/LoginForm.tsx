"use client";

import { useEffect, useState } from "react";
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";

function nextTarget(): string {
  if (typeof window === "undefined") return "/";
  const p = new URLSearchParams(window.location.search).get("next");
  return p && p.startsWith("/") ? p : "/";
}

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"form" | "offerBiometric">("form");
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "כניסה נכשלה");
      }
      // הצלחה — מציעים להפעיל זיהוי ביומטרי במכשיר זה.
      if (supported) setPhase("offerBiometric");
      else window.location.href = nextTarget();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  async function biometricLogin() {
    setError("");
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/webauthn/login/options", { method: "POST" });
      if (!optRes.ok) {
        const d = await optRes.json().catch(() => ({}));
        throw new Error(d.error ?? "אין מפתחות רשומים במכשיר זה");
      }
      const optionsJSON = await optRes.json();
      const assertion = await startAuthentication({ optionsJSON });
      const verifyRes = await fetch("/api/auth/webauthn/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assertion),
      });
      if (!verifyRes.ok) throw new Error("האימות נכשל");
      window.location.href = nextTarget();
    } catch (err) {
      setError(err instanceof Error ? err.message : "הזיהוי הביומטרי נכשל");
    } finally {
      setBusy(false);
    }
  }

  async function enableBiometric() {
    setError("");
    setBusy(true);
    try {
      const optRes = await fetch("/api/auth/webauthn/register/options", { method: "POST" });
      if (!optRes.ok) throw new Error("לא ניתן להפעיל כעת");
      const optionsJSON = await optRes.json();
      const attestation = await startRegistration({ optionsJSON });
      const verifyRes = await fetch("/api/auth/webauthn/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attestation),
      });
      if (!verifyRes.ok) throw new Error("הרישום נכשל");
      window.location.href = nextTarget();
    } catch {
      // אם נכשל/בוטל — ממשיכים בכל מקרה פנימה.
      setInfo("לא הופעל זיהוי ביומטרי. אפשר להפעיל בכניסה הבאה.");
      setTimeout(() => (window.location.href = nextTarget()), 1200);
    } finally {
      setBusy(false);
    }
  }

  if (phase === "offerBiometric") {
    return (
      <div className="text-center">
        <p className="text-4xl">🔐</p>
        <h2 className="mt-3 text-lg font-bold text-slate-800 dark:text-slate-100">הפעלת כניסה בזיהוי פנים?</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          בכניסות הבאות תוכל/י להיכנס במהירות עם Face ID / טביעת אצבע של המכשיר.
        </p>
        {info && <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{info}</p>}
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={enableBiometric}
            disabled={busy}
            className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? "מפעיל..." : "הפעלת זיהוי פנים"}
          </button>
          <button
            type="button"
            onClick={() => (window.location.href = nextTarget())}
            className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            דילוג
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-brand-700">מערכת משאבי אנוש</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">כניסה למערכת</p>
      </div>

      <form onSubmit={submitPassword} className="space-y-3">
        <input
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2.5 text-base outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
          placeholder="שם משתמש"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
        <input
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2.5 text-base outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
          placeholder="סיסמה"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? "מתחבר..." : "כניסה"}
        </button>
      </form>

      {supported && (
        <button
          type="button"
          onClick={biometricLogin}
          disabled={busy}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200 transition hover:bg-slate-50 dark:hover:bg-slate-800/60 disabled:opacity-60"
        >
          🔓 כניסה עם זיהוי פנים / טביעת אצבע
        </button>
      )}
    </div>
  );
}
