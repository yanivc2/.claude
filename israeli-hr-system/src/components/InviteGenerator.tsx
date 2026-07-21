"use client";

import { useEffect, useState } from "react";

interface Invite {
  id: string;
  url: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  status: "PENDING" | "COMPLETED" | "CANCELLED";
  createdAt: string;
  employeeName: string | null;
}

const STATUS_LABEL: Record<Invite["status"], string> = {
  PENDING: "ממתין למילוי",
  COMPLETED: "הושלם",
  CANCELLED: "בוטל",
};

const STATUS_STYLE: Record<Invite["status"], string> = {
  PENDING: "bg-amber-50 text-amber-700",
  COMPLETED: "bg-green-50 text-green-700",
  CANCELLED: "bg-slate-100 text-slate-500",
};

// כפתור העתקה לזיכרון עם משוב חזותי קצר.
function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // אם ההעתקה נכשלה (הרשאות דפדפן) — בוחרים את הטקסט לבחירה ידנית.
          window.prompt("העתק/י את הקישור:", url);
        }
      }}
      className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-700"
    >
      {copied ? "✓ הועתק" : "העתקת קישור"}
    </button>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-base sm:text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

export function InviteGenerator() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  async function loadInvites() {
    try {
      const res = await fetch("/api/onboarding/invite");
      if (res.ok) setInvites(await res.json());
    } catch {
      // התעלמות — הרשימה תישאר ריקה עד לרענון.
    }
  }

  useEffect(() => {
    loadInvites();
  }, []);

  async function generate() {
    setLoading(true);
    setError("");
    setNewUrl(null);
    try {
      const res = await fetch("/api/onboarding/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName, email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "שגיאה ביצירת הקישור");
      setNewUrl(data.url);
      setFirstName("");
      setLastName("");
      setEmail("");
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mb-8 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-slate-800">שליחת קישור קליטה לעובד</h2>
      <p className="mt-1 text-sm text-slate-500">
        צור/י קישור אישי ומאובטח ושלח/י לעובד (ב-WhatsApp, מייל או SMS). העובד ימלא את
        הטופס, יעלה ת.ז ויחתום — והפרטים יישמרו כאן אוטומטית.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <input
          className={inputClass}
          placeholder="שם פרטי (אופציונלי)"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <input
          className={inputClass}
          placeholder="שם משפחה (אופציונלי)"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
        <input
          className={inputClass}
          type="email"
          placeholder="דוא״ל (אופציונלי)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <button
        type="button"
        onClick={generate}
        disabled={loading}
        className="mt-4 w-full rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60 sm:w-auto"
      >
        {loading ? "יוצר קישור..." : "➕ יצירת קישור קליטה"}
      </button>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {newUrl && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm font-medium text-green-800">הקישור נוצר! העתק/י ושלח/י לעובד:</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              readOnly
              value={newUrl}
              onFocus={(e) => e.target.select()}
              className="min-w-0 flex-1 rounded-lg border border-green-300 bg-white px-3 py-2 text-xs text-slate-700"
            />
            <CopyButton url={newUrl} />
          </div>
        </div>
      )}

      {invites.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">קישורים שנוצרו</h3>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {invites.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-800">
                    {inv.employeeName ||
                      [inv.firstName, inv.lastName].filter(Boolean).join(" ") ||
                      "עובד ללא שם"}
                  </p>
                  <p className="truncate text-xs text-slate-400">{inv.url}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[inv.status]}`}
                  >
                    {STATUS_LABEL[inv.status]}
                  </span>
                  {inv.status === "PENDING" && <CopyButton url={inv.url} />}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
