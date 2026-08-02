"use client";

import { useEffect, useState } from "react";
import { UserPlus, Mail, Phone, Trash2, Briefcase, Landmark } from "lucide-react";
import { useCanWrite } from "./ViewerProvider";

type ContactType = "GENERAL" | "PENSION_AGENT";

interface Contact {
  id: string;
  type: ContactType;
  name: string;
  agency: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  companyId: string | null;
}

const inputClass =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2.5 text-base sm:text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

const TYPE_LABEL: Record<ContactType, string> = {
  GENERAL: "איש קשר",
  PENSION_AGENT: "מטפל תיק פנסיוני",
};

export function ContactsManager() {
  const canWrite = useCanWrite();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [type, setType] = useState<ContactType>("PENSION_AGENT");
  const [name, setName] = useState("");
  const [agency, setAgency] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const res = await fetch("/api/contacts").catch(() => null);
    if (res?.ok) setContacts(await res.json());
  }
  useEffect(() => {
    load();
    fetch("/api/companies")
      .then((r) => (r.ok ? r.json() : []))
      .then(setCompanies)
      .catch(() => {});
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, name, agency, email, phone, notes, companyId: companyId || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "שגיאה בהוספה");
      setName("");
      setAgency("");
      setEmail("");
      setPhone("");
      setNotes("");
      setCompanyId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Contact) {
    if (!window.confirm(`למחוק את "${c.name}"?`)) return;
    const res = await fetch(`/api/contacts/${c.id}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) await load();
  }

  return (
    <div className="space-y-6">
      {canWrite && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
          <h2 className="mb-4 text-base font-bold text-slate-800 dark:text-slate-100">הוספת איש קשר</h2>
          <form onSubmit={add} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">סוג</span>
              <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as ContactType)}>
                <option value="PENSION_AGENT">מטפל תיק פנסיוני</option>
                <option value="GENERAL">איש קשר כללי</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">שם</span>
              <input className={inputClass} required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">סוכנות / חברה</span>
              <input className={inputClass} value={agency} onChange={(e) => setAgency(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">דוא״ל</span>
              <input className={inputClass} type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">טלפון / וואטסאפ</span>
              <input
                className={inputClass}
                dir="ltr"
                placeholder="+9725..."
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">שיוך לחברה (רשות)</span>
              <select className={inputClass} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">— ללא —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">הערות</span>
              <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            {error && <p className="text-sm text-red-600 dark:text-red-400 sm:col-span-2">{error}</p>}
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105 disabled:opacity-60"
              >
                <UserPlus size={16} />
                {busy ? "מוסיף..." : "הוספה"}
              </button>
            </div>
          </form>
        </section>
      )}

      <div className="space-y-2">
        {contacts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400 dark:border-slate-700">
            אין אנשי קשר עדיין.
          </p>
        ) : (
          contacts.map((c, i) => (
            <div
              key={c.id}
              style={{ "--i": i } as React.CSSProperties}
              className="animate-stagger flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-white/80 p-3 shadow-soft backdrop-blur-sm transition hover:shadow-card dark:border-slate-800 dark:bg-slate-900/70"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                    c.type === "PENSION_AGENT"
                      ? "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300"
                      : "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300"
                  }`}
                >
                  {c.type === "PENSION_AGENT" ? <Landmark size={17} /> : <Briefcase size={17} />}
                </span>
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800 dark:text-slate-100">
                    {c.name}
                    <span className="mr-2 text-xs font-normal text-slate-400">{TYPE_LABEL[c.type]}</span>
                  </p>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {c.agency && <span>{c.agency}</span>}
                    {c.email && (
                      <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 hover:underline" dir="ltr">
                        <Mail size={12} /> {c.email}
                      </a>
                    )}
                    {c.phone && (
                      <span className="inline-flex items-center gap-1" dir="ltr">
                        <Phone size={12} /> {c.phone}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => remove(c)}
                  className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-400"
                  aria-label="מחיקה"
                >
                  <Trash2 size={17} />
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
