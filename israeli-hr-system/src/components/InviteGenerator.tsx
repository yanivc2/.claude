"use client";

import { useEffect, useState } from "react";

interface Invite {
  id: string;
  token: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  status: "PENDING" | "COMPLETED" | "CANCELLED";
  createdAt: string;
  employeeName: string | null;
  hasContract: boolean;
}

// בונה את הקישור מהכתובת שבה ה-HR גולש בפועל — כך הוא תמיד תואם לדומיין
// הנוכחי (Vercel / localhost) בלי תלות במשתני סביבה.
function linkFor(token: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/onboard/${token}`;
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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const inviteMessage = (url: string) =>
  `שלום, להשלמת הקליטה אנא מלא/י את הטופס בקישור:\n${url}`;
const waHref = (url: string) => `https://wa.me/?text=${encodeURIComponent(inviteMessage(url))}`;
const mailHref = (url: string, email?: string | null) =>
  `mailto:${email ?? ""}?subject=${encodeURIComponent("טופס קליטה לעובד")}&body=${encodeURIComponent(
    inviteMessage(url),
  )}`;

// כפתורי שליחה ישירה לוואטסאפ ולמייל.
function ShareButtons({ url, email }: { url: string; email?: string | null }) {
  return (
    <>
      <a
        href={waHref(url)}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-700"
      >
        📱 וואטסאפ
      </a>
      <a
        href={mailHref(url, email)}
        className="shrink-0 rounded-lg bg-slate-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700"
      >
        ✉️ מייל
      </a>
    </>
  );
}

export function InviteGenerator() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [monthlySalary, setMonthlySalary] = useState("");
  const [hourlySalary, setHourlySalary] = useState("");
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(false);
  const [newInvite, setNewInvite] = useState<{ url: string; email: string } | null>(null);
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

  async function deleteInvite(id: string) {
    if (!confirm("למחוק את קישור הקליטה? פעולה זו אינה מוחקת עובד שכבר נקלט.")) return;
    try {
      const res = await fetch(`/api/onboarding/invite/${id}`, { method: "DELETE" });
      if (res.ok) setInvites((prev) => prev.filter((i) => i.id !== id));
    } catch {
      // התעלמות — ניתן לרענן ידנית.
    }
  }

  async function generate() {
    setLoading(true);
    setError("");
    setNewInvite(null);
    try {
      const contract = contractFile
        ? {
            fileName: contractFile.name,
            mimeType: contractFile.type,
            data: await fileToDataUrl(contractFile),
          }
        : null;

      const res = await fetch("/api/onboarding/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          companyName,
          jobTitle,
          monthlySalary: monthlySalary ? Number(monthlySalary) : null,
          hourlySalary: hourlySalary ? Number(hourlySalary) : null,
          contract,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "שגיאה ביצירת הקישור");
      setNewInvite({ url: linkFor(data.token), email });
      setFirstName("");
      setLastName("");
      setEmail("");
      setJobTitle("");
      setMonthlySalary("");
      setHourlySalary("");
      setContractFile(null);
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

      <div className="mt-4">
        <input
          className={inputClass}
          placeholder="שם החברה (יופיע ככותרת לעובד בקישור)"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
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

      {/* פרטי העסקה שה-HR קובע — אינם מוצגים לעובד */}
      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-xs font-medium text-slate-500">
          פרטי העסקה (למעסיק בלבד — לא מוצג לעובד)
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <input
            className={inputClass}
            placeholder="תפקיד"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          />
          <input
            className={inputClass}
            type="number"
            inputMode="numeric"
            placeholder="שכר חודשי (₪)"
            value={monthlySalary}
            onChange={(e) => setMonthlySalary(e.target.value)}
          />
          <input
            className={inputClass}
            type="number"
            inputMode="numeric"
            placeholder="שכר שעתי (₪)"
            value={hourlySalary}
            onChange={(e) => setHourlySalary(e.target.value)}
          />
        </div>
      </div>

      {/* צירוף הסכם עבודה שיישלח לעובד לקריאה וחתימה */}
      <div className="mt-3">
        <label className="mb-1 block text-sm font-medium text-slate-700">
          צירוף הסכם עבודה לשליחה לעובד (אופציונלי)
        </label>
        <input
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setContractFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-slate-600 file:ml-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700"
        />
        {contractFile && (
          <p className="mt-1 text-xs text-green-700">מצורף: {contractFile.name}</p>
        )}
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

      {newInvite && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4">
          <p className="text-sm font-medium text-green-800">הקישור נוצר! שלח/י לעובד:</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              readOnly
              value={newInvite.url}
              onFocus={(e) => e.target.select()}
              className="min-w-0 flex-1 rounded-lg border border-green-300 bg-white px-3 py-2 text-xs text-slate-700"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <CopyButton url={newInvite.url} />
            <ShareButtons url={newInvite.url} email={newInvite.email} />
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
                  <p className="truncate text-xs text-slate-400">{linkFor(inv.token)}</p>
                  {inv.hasContract && (
                    <p className="mt-0.5 text-xs text-slate-500">📄 הסכם עבודה מצורף</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[inv.status]}`}
                  >
                    {STATUS_LABEL[inv.status]}
                  </span>
                  {inv.status === "PENDING" && (
                    <>
                      <CopyButton url={linkFor(inv.token)} />
                      <ShareButtons url={linkFor(inv.token)} email={inv.email} />
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteInvite(inv.id)}
                    aria-label="מחיקת קישור"
                    title="מחיקת קישור"
                    className="shrink-0 rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-red-600 transition hover:bg-red-50"
                  >
                    🗑️ מחיקה
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
