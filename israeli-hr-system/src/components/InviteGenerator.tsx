"use client";

import { useEffect, useState } from "react";
import { Send, Plus } from "lucide-react";

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
  PENDING: "bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
  COMPLETED: "bg-green-50 dark:bg-green-500/15 text-green-700 dark:text-green-400",
  CANCELLED: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400",
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
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2.5 text-base sm:text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

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

// שיתוף הזמנה בוואטסאפ. במובייל מעדיפים את Web Share API — הוא פותח את גיליון
// השיתוף המקורי של המכשיר, שם בוחרים וואטסאפ ואז איש קשר, עם הטקסט מוכן מראש.
// אם ה-API אינו זמין (דסקטופ) — נופלים חזרה לקישור wa.me הקלאסי.
async function shareInvite(url: string) {
  const text = inviteMessage(url);
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      // ביטול ע"י המשתמש — לא עושים כלום; שגיאה אחרת — נופלים לקישור וואטסאפ.
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  window.open(waHref(url), "_blank", "noopener,noreferrer");
}

// כפתורי שליחה ישירה לוואטסאפ ולמייל.
function ShareButtons({ url, email }: { url: string; email?: string | null }) {
  return (
    <>
      <button
        type="button"
        onClick={() => shareInvite(url)}
        className="shrink-0 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-700"
      >
        📱 וואטסאפ
      </button>
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
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [newCompany, setNewCompany] = useState("");
  const [newCompanyNumber, setNewCompanyNumber] = useState("");
  const [newCompanyAddress, setNewCompanyAddress] = useState("");
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

  async function loadCompanies() {
    try {
      const res = await fetch("/api/companies");
      if (res.ok) setCompanies(await res.json());
    } catch {
      // התעלמות.
    }
  }

  useEffect(() => {
    loadInvites();
    loadCompanies();
  }, []);

  async function addCompany() {
    const name = newCompany.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          companyNumber: newCompanyNumber,
          address: newCompanyAddress,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCompanies((prev) =>
          [...prev, data].sort((a, b) => a.name.localeCompare(b.name, "he")),
        );
        setCompanyName(data.name);
        setNewCompany("");
        setNewCompanyNumber("");
        setNewCompanyAddress("");
      }
    } catch {
      // התעלמות.
    }
  }

  async function deleteCompany(id: string, name: string) {
    if (!confirm(`למחוק את החברה "${name}" מרשימת האפשרויות?`)) return;
    try {
      const res = await fetch(`/api/companies/${id}`, { method: "DELETE" });
      if (res.ok) {
        setCompanies((prev) => prev.filter((c) => c.id !== id));
        if (companyName === name) setCompanyName("");
      }
    } catch {
      // התעלמות.
    }
  }

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
    <section className="mb-8 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
          <Send size={20} />
        </span>
        <div>
          <h2 className="text-lg font-bold leading-tight text-slate-800 dark:text-slate-100">
            שליחת קישור קליטה לעובד
          </h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            העובד ממלא את הטופס בעצמו — פרטים, ת.ז וחתימה — והכול נשמר כאן אוטומטית.
          </p>
        </div>
      </div>

      {/* בחירת חברה + ניהול רשימת החברות */}
      <div className="mt-4">
        <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
          חברה (תופיע ככותרת לעובד בקישור)
        </label>
        <select
          className={inputClass}
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
        >
          <option value="">— בחר/י חברה —</option>
          {companies.map((c) => (
            <option key={c.id} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>

        <div className="mt-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-3">
          <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            הוספת חברה חדשה (ח.פ. וכתובת נדרשים למדיניות הפרטיות)
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              className={inputClass}
              placeholder="שם החברה"
              value={newCompany}
              onChange={(e) => setNewCompany(e.target.value)}
            />
            <input
              className={inputClass}
              placeholder="ח.פ."
              value={newCompanyNumber}
              onChange={(e) => setNewCompanyNumber(e.target.value)}
            />
            <input
              className={inputClass}
              placeholder="כתובת"
              value={newCompanyAddress}
              onChange={(e) => setNewCompanyAddress(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={addCompany}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/15 px-3 py-2 text-sm font-medium text-brand-700 dark:text-brand-300 transition hover:bg-brand-100 dark:hover:bg-brand-500/25"
          >
            <Plus size={15} strokeWidth={2.6} />
            הוספת חברה
          </button>
        </div>

        {companies.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {companies.map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 px-3 py-1 text-xs text-slate-600 dark:text-slate-300"
              >
                {c.name}
                <button
                  type="button"
                  onClick={() => deleteCompany(c.id, c.name)}
                  aria-label={`מחיקת ${c.name}`}
                  className="text-red-500 hover:text-red-700"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
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
      <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-3">
        <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          פרטי העסקה (למעסיק בלבד — לא מוצג לעובד)
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <select
            className={inputClass}
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          >
            <option value="">תפקיד</option>
            {["קופאי", "סדרן", "עובד כללי", "מנהל"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
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
        <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
          צירוף הסכם עבודה לשליחה לעובד (אופציונלי)
        </label>
        <input
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setContractFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-slate-600 dark:text-slate-300 file:ml-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700"
        />
        {contractFile && (
          <p className="mt-1 text-xs text-green-700 dark:text-green-400">מצורף: {contractFile.name}</p>
        )}
      </div>

      <button
        type="button"
        onClick={generate}
        disabled={loading}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-3 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105 disabled:opacity-60 sm:w-auto"
      >
        <Plus size={17} strokeWidth={2.6} />
        {loading ? "יוצר קישור..." : "יצירת קישור קליטה"}
      </button>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-500/15 px-4 py-3 text-sm text-red-700 dark:text-red-400">{error}</p>
      )}

      {newInvite && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 dark:bg-green-500/15 p-4">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">הקישור נוצר! שלח/י לעובד:</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              readOnly
              value={newInvite.url}
              onFocus={(e) => e.target.select()}
              className="min-w-0 flex-1 rounded-lg border border-green-300 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-700 dark:text-slate-200"
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
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">קישורים שנוצרו</h3>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
            {invites.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-800 dark:text-slate-100">
                    {inv.employeeName ||
                      [inv.firstName, inv.lastName].filter(Boolean).join(" ") ||
                      "עובד ללא שם"}
                  </p>
                  <p className="truncate text-xs text-slate-400 dark:text-slate-400">{linkFor(inv.token)}</p>
                  {inv.hasContract && (
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">📄 הסכם עבודה מצורף</p>
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
                    className="shrink-0 rounded-lg border border-slate-300 dark:border-slate-700 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 transition hover:bg-red-50 dark:hover:bg-red-500/15"
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
