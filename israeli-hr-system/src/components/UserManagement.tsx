"use client";

import { useEffect, useState } from "react";
import { UsersRound, UserPlus } from "lucide-react";
import { avatarColor, initials } from "@/lib/avatar";

interface ManagedUser {
  id: string;
  username: string;
  name: string;
  email: string;
  isOwner: boolean;
  active: boolean;
  createdAt: string;
}

const inputClass =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2.5 text-base sm:text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

// שם פרטי/משפחה לצורך ראשי־תיבות באווטאר.
function splitName(full: string): [string, string] {
  const parts = full.trim().split(/\s+/);
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

// כתובת מסך הכניסה — נבנית מהדומיין שבו גולשים בפועל (Vercel/localhost).
function loginUrl(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/login`;
}

// הודעה עם פרטי הכניסה המלאים (כולל סיסמה ראשונית) — לשליחה מיד לאחר היצירה.
function credentialsMessage(name: string, username: string, password: string): string {
  return (
    `שלום ${name}, נפתח עבורך חשבון במערכת משאבי האנוש.\n` +
    `קישור לכניסה: ${loginUrl()}\n` +
    `שם משתמש: ${username}\n` +
    `סיסמה ראשונית: ${password}\n` +
    `מומלץ להחליף סיסמה לאחר הכניסה הראשונה (הגדרות ← שינוי סיסמה).`
  );
}

// הודעת קישור בלבד (ללא סיסמה) — לשליחה חוזרת של הקישור למשתמש קיים.
function linkMessage(name: string, username: string): string {
  return (
    `שלום ${name}, קישור לכניסה למערכת משאבי האנוש: ${loginUrl()}\n` +
    `שם משתמש: ${username}`
  );
}

// שיתוף בוואטסאפ: מעדיף את Web Share (גיליון שיתוף מקורי עם בורר אנשי קשר),
// ונופל לקישור wa.me בדסקטופ.
async function shareWhatsApp(text: string) {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
}

function mailtoHref(email: string, body: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(
    "פרטי כניסה — מערכת משאבי אנוש",
  )}&body=${encodeURIComponent(body)}`;
}

// ניהול משתמשי המערכת — מוצג רק לבעלים. יצירת משתמש חדש, השבתה/הפעלה,
// ואיפוס סיסמה. משתמשים חדשים יכולים להתחבר ולעבוד עם המערכת.
export function UserManagement() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // המשתמש שזה עתה נוצר — לשמירת פרטי הכניסה לצורך שליחתם בוואטסאפ/מייל.
  const [created, setCreated] = useState<{
    name: string;
    username: string;
    email: string;
    password: string;
  } | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/users");
      if (res.ok) setUsers(await res.json());
    } catch {
      // מתעלמים — הרשימה תישאר ריקה עד לרענון.
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setCreated(null);
    setBusy(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, username, email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "שגיאה ביצירת המשתמש");
      // שומרים את הפרטים כדי לאפשר שליחתם בוואטסאפ/מייל, ואז מנקים את הטופס.
      setCreated({ name, username, email, password });
      setName("");
      setUsername("");
      setEmail("");
      setPassword("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u: ManagedUser) {
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !u.active }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "שגיאה בעדכון המשתמש");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    }
  }

  async function resetPassword(u: ManagedUser) {
    const pw = window.prompt(`סיסמה חדשה עבור "${u.username}" (לפחות 6 תווים):`);
    if (pw === null) return;
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "שגיאה באיפוס הסיסמה");
      setNotice(`הסיסמה של "${u.username}" עודכנה.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <UsersRound size={20} />
        </span>
        <div>
          <h2 className="text-lg font-bold leading-tight text-slate-800 dark:text-slate-100">משתמשי המערכת</h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            יצירת משתמשים נוספים לעבודה במערכת — זמין לבעל המערכת בלבד.
          </p>
        </div>
      </div>

      {/* יצירת משתמש חדש */}
      <form onSubmit={createUser} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">שם מלא</span>
          <input className={inputClass} required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">שם משתמש (לכניסה)</span>
          <input
            className={inputClass}
            required
            dir="ltr"
            autoComplete="off"
            placeholder="לדוגמה: nissim"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">דוא״ל</span>
          <input
            className={inputClass}
            type="email"
            required
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">סיסמה ראשונית</span>
          <input
            className={inputClass}
            type="text"
            required
            dir="ltr"
            minLength={6}
            placeholder="לפחות 6 תווים"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand-500/25 transition hover:brightness-105 disabled:opacity-60"
          >
            <UserPlus size={16} />
            {busy ? "יוצר..." : "יצירת משתמש"}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-500/15 px-4 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      {notice && (
        <p className="mt-3 rounded-lg bg-green-50 dark:bg-green-500/15 px-4 py-2 text-sm text-green-700 dark:text-green-400">{notice}</p>
      )}

      {/* כרטיס לאחר יצירה — שליחת פרטי הכניסה למשתמש */}
      {created && (
        <div className="mt-4 rounded-xl border border-green-300 bg-green-50 dark:bg-green-500/15 p-4">
          <p className="text-sm font-semibold text-green-800 dark:text-green-300">
            ✓ המשתמש &ldquo;{created.name}&rdquo; נוצר. שלח/י לו את פרטי הכניסה:
          </p>
          <div className="mt-2 rounded-lg bg-white dark:bg-slate-900 p-3 text-sm text-slate-700 dark:text-slate-200" dir="ltr">
            <p>
              <span className="text-slate-400 dark:text-slate-400">כניסה:</span> {loginUrl()}
            </p>
            <p>
              <span className="text-slate-400 dark:text-slate-400">שם משתמש:</span> {created.username}
            </p>
            <p>
              <span className="text-slate-400 dark:text-slate-400">סיסמה:</span> {created.password}
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                shareWhatsApp(credentialsMessage(created.name, created.username, created.password))
              }
              className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-700"
            >
              📱 שליחה בוואטסאפ
            </button>
            <a
              href={mailtoHref(
                created.email,
                credentialsMessage(created.name, created.username, created.password),
              )}
              className="rounded-lg bg-slate-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700"
            >
              ✉️ שליחה במייל
            </a>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 transition hover:bg-white"
            >
              סגירה
            </button>
          </div>
          <p className="mt-2 text-xs text-green-700 dark:text-green-400">
            הסיסמה מוצגת כאן פעם אחת בלבד. מומלץ שהמשתמש יחליף אותה לאחר הכניסה הראשונה.
          </p>
        </div>
      )}

      {/* רשימת המשתמשים */}
      <div className="mt-6 space-y-2">
        {users.map((u) => (
          <div
            key={u.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 p-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br text-xs font-bold text-white ${avatarColor(
                  u.name || u.username,
                )}`}
              >
                {initials(...splitName(u.name || u.username))}
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-slate-800 dark:text-slate-100">
                  {u.name}{" "}
                  <span className="text-sm font-normal text-slate-400 dark:text-slate-400" dir="ltr">
                    @{u.username}
                  </span>
                </p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400" dir="ltr">
                  {u.email}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {u.isOwner ? (
                <span className="rounded-full bg-brand-50 dark:bg-brand-500/15 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300">
                  בעל המערכת
                </span>
              ) : (
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                    u.active ? "bg-green-50 dark:bg-green-500/15 text-green-700 dark:text-green-400" : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {u.active ? "פעיל" : "מושבת"}
                </span>
              )}
              {!u.isOwner && u.active && (
                <>
                  <button
                    type="button"
                    title="שליחת קישור כניסה בוואטסאפ"
                    onClick={() => shareWhatsApp(linkMessage(u.name, u.username))}
                    className="rounded-lg border border-green-300 px-2.5 py-1 text-xs text-green-700 dark:text-green-400 transition hover:bg-green-50"
                  >
                    📱 קישור
                  </button>
                  <a
                    title="שליחת קישור כניסה במייל"
                    href={mailtoHref(u.email, linkMessage(u.name, u.username))}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs text-slate-600 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    ✉️ קישור
                  </a>
                </>
              )}
              {!u.isOwner && (
                <>
                  <button
                    type="button"
                    onClick={() => resetPassword(u)}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1 text-xs text-slate-600 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    איפוס סיסמה
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleActive(u)}
                    className={`rounded-lg px-3 py-1 text-xs font-semibold text-white transition ${
                      u.active ? "bg-slate-500 hover:bg-slate-600" : "bg-green-600 hover:bg-green-700"
                    }`}
                  >
                    {u.active ? "השבתה" : "הפעלה"}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
