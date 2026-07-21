"use client";

import { useEffect, useState } from "react";

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
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-base sm:text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

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
    setBusy(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, username, email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "שגיאה ביצירת המשתמש");
      setNotice(`המשתמש "${username}" נוצר. אפשר להעביר לו את שם המשתמש והסיסמה לכניסה.`);
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
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-slate-800">משתמשי המערכת</h2>
      <p className="mt-1 text-sm text-slate-500">
        יצירת משתמשים נוספים שיוכלו להתחבר ולעבוד עם המערכת. אפשרות זו זמינה לך בלבד (בעל המערכת).
      </p>

      {/* יצירת משתמש חדש */}
      <form onSubmit={createUser} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">שם מלא</span>
          <input className={inputClass} required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">שם משתמש (לכניסה)</span>
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
          <span className="mb-1 block text-sm font-medium text-slate-700">דוא״ל</span>
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
          <span className="mb-1 block text-sm font-medium text-slate-700">סיסמה ראשונית</span>
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
            className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? "יוצר..." : "יצירת משתמש"}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {notice && (
        <p className="mt-3 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">{notice}</p>
      )}

      {/* רשימת המשתמשים */}
      <div className="mt-6 space-y-2">
        {users.map((u) => (
          <div
            key={u.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3"
          >
            <div className="min-w-0">
              <p className="font-medium text-slate-800">
                {u.name}{" "}
                <span className="text-sm font-normal text-slate-400" dir="ltr">
                  @{u.username}
                </span>
              </p>
              <p className="text-xs text-slate-500" dir="ltr">
                {u.email}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {u.isOwner ? (
                <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                  בעל המערכת
                </span>
              ) : (
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                    u.active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {u.active ? "פעיל" : "מושבת"}
                </span>
              )}
              {!u.isOwner && (
                <>
                  <button
                    type="button"
                    onClick={() => resetPassword(u)}
                    className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 transition hover:bg-slate-50"
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
