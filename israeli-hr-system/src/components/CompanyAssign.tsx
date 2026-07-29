"use client";

import { useEffect, useState } from "react";
import { Building2, Check } from "lucide-react";
import { useCanWrite } from "./ViewerProvider";

interface CompanyOption {
  id: string;
  name: string;
}

// שיוך עובד לחברה — בסיס ההפרדה המולטי-חברה. עריכה לבעלים/מזכירה בלבד;
// מנהל חנות רואה את שם החברה בלבד (קריאה).
export function CompanyAssign({
  employeeId,
  companyId,
  companyName,
}: {
  employeeId: string;
  companyId: string | null;
  companyName: string | null;
}) {
  const canWrite = useCanWrite();
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [value, setValue] = useState(companyId ?? "");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canWrite) return;
    fetch("/api/companies")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: CompanyOption[]) => setCompanies(list))
      .catch(() => {});
  }, [canWrite]);

  async function save(next: string) {
    setValue(next);
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch(`/api/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: next || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "שגיאה בשמירת החברה");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
      setValue(companyId ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <Building2 size={16} className="shrink-0 text-slate-400" />
      <span className="text-slate-500 dark:text-slate-400">חברה:</span>
      {canWrite ? (
        <>
          <select
            value={value}
            disabled={busy}
            onChange={(e) => save(e.target.value)}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm text-slate-700 dark:text-slate-200 disabled:opacity-60"
          >
            <option value="">— ללא שיוך —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {saved && <Check size={16} className="text-green-600 dark:text-green-400" />}
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </>
      ) : (
        <span className="font-medium text-slate-700 dark:text-slate-200">{companyName ?? "—"}</span>
      )}
    </div>
  );
}
