"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, Users, X } from "lucide-react";
import type { EmploymentStatus } from "@prisma/client";
import { EmployeeRowActions } from "@/components/EmployeeRowActions";
import { EmptyState } from "@/components/EmptyState";
import { avatarColor, initials } from "@/lib/avatar";

// שורת עובד מצומצמת (סריאליזבילית) שמגיעה מרכיב השרת.
export interface EmployeeRow {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  nationalId: string;
  startDate: string; // ISO
  status: EmploymentStatus;
}

const STATUS_LABELS: Record<EmploymentStatus, string> = {
  ONBOARDING: "בתהליך קליטה",
  ACTIVE: "פעיל",
  NOTICE_PERIOD: "בהודעה מוקדמת",
  INACTIVE: "לא פעיל",
  TERMINATED: "סיום העסקה",
};

const STATUS_STYLES: Record<EmploymentStatus, string> = {
  ONBOARDING: "bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
  ACTIVE: "bg-green-50 dark:bg-green-500/15 text-green-700 dark:text-green-400",
  NOTICE_PERIOD: "bg-orange-50 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300",
  INACTIVE: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400",
  TERMINATED: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400",
};

const INACTIVE_STATUSES: EmploymentStatus[] = ["INACTIVE", "TERMINATED"];
const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });

// מסננים זמינים: "הכול", קבוצת "פעילים" (כל מי שאינו לא־פעיל), ולפי סטטוס.
type Filter = "ALL" | "WORKING" | EmploymentStatus;

function EmployeeTable({ employees }: { employees: EmployeeRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
      <table className="w-full min-w-[42rem] text-start text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-400">
            <th className="px-5 py-3 text-start font-bold">שם</th>
            <th className="px-5 py-3 text-start font-bold">תפקיד</th>
            <th className="px-5 py-3 text-start font-bold">תחילת עבודה</th>
            <th className="px-5 py-3 text-start font-bold">סטטוס</th>
            <th className="px-5 py-3 text-start font-bold">פעולות</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => (
            <tr
              key={e.id}
              className="border-t border-slate-100 dark:border-slate-800 transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
            >
              <td className="px-5 py-3">
                <Link href={`/employees/${e.id}`} className="flex items-center gap-3">
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br text-xs font-bold text-white ${avatarColor(
                      e.firstName + e.lastName,
                    )}`}
                  >
                    {initials(e.firstName, e.lastName)}
                  </span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {e.firstName} {e.lastName}
                  </span>
                </Link>
              </td>
              <td className="px-5 py-3 text-slate-500 dark:text-slate-400">{e.jobTitle || "—"}</td>
              <td className="px-5 py-3 tabular-nums text-slate-500 dark:text-slate-400">
                {dateFmt.format(new Date(e.startDate))}
              </td>
              <td className="px-5 py-3">
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_STYLES[e.status]}`}>
                  {STATUS_LABELS[e.status]}
                </span>
              </td>
              <td className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/employees/${e.id}`}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 transition hover:border-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10"
                  >
                    פתיחת תיק
                  </Link>
                  <EmployeeRowActions
                    id={e.id}
                    name={`${e.firstName} ${e.lastName}`}
                    isInactive={INACTIVE_STATUSES.includes(e.status)}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmployeesList({ employees }: { employees: EmployeeRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");

  // ספירת עובדים לכל מסנן — להצגה בתגי הסינון.
  const counts = useMemo(() => {
    const c = {
      ALL: employees.length,
      WORKING: 0,
      ACTIVE: 0,
      ONBOARDING: 0,
      NOTICE_PERIOD: 0,
      INACTIVE: 0,
    };
    for (const e of employees) {
      if (!INACTIVE_STATUSES.includes(e.status)) c.WORKING += 1;
      if (e.status === "ACTIVE") c.ACTIVE += 1;
      else if (e.status === "ONBOARDING") c.ONBOARDING += 1;
      else if (e.status === "NOTICE_PERIOD") c.NOTICE_PERIOD += 1;
      else c.INACTIVE += 1; // INACTIVE + TERMINATED
    }
    return c;
  }, [employees]);

  const chips: { key: Filter; label: string; count: number }[] = [
    { key: "ALL", label: "הכול", count: counts.ALL },
    { key: "WORKING", label: "מועסקים", count: counts.WORKING },
    { key: "ONBOARDING", label: "בקליטה", count: counts.ONBOARDING },
    { key: "NOTICE_PERIOD", label: "בהודעה מוקדמת", count: counts.NOTICE_PERIOD },
    { key: "INACTIVE", label: "לא פעילים", count: counts.INACTIVE },
  ];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return employees.filter((e) => {
      // מסנן סטטוס
      if (filter === "WORKING" && INACTIVE_STATUSES.includes(e.status)) return false;
      if (filter === "INACTIVE" && !INACTIVE_STATUSES.includes(e.status)) return false;
      if (filter !== "ALL" && filter !== "WORKING" && filter !== "INACTIVE" && e.status !== filter)
        return false;
      // חיפוש חופשי לפי שם / תפקיד / ת.ז
      if (!q) return true;
      const hay = `${e.firstName} ${e.lastName} ${e.jobTitle ?? ""} ${e.nationalId}`.toLowerCase();
      return hay.includes(q);
    });
  }, [employees, query, filter]);

  const chipCls = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
      active
        ? "bg-brand-600 text-white shadow-sm shadow-brand-500/25"
        : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:border-brand-300 hover:text-brand-700 dark:hover:text-brand-300"
    }`;

  return (
    <div className="space-y-4">
      {/* סרגל כלים: חיפוש + סינון לפי סטטוס */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-xs">
          <Search
            size={16}
            className="pointer-events-none absolute inset-y-0 right-3 my-auto text-slate-400 dark:text-slate-500"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="חיפוש לפי שם, תפקיד או ת.ז…"
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 py-2.5 pe-9 ps-9 text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="ניקוי חיפוש"
              className="absolute inset-y-0 left-2 my-auto grid h-6 w-6 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={chipCls(filter === c.key)}
            >
              {c.label}
              <span
                className={`tabular-nums ${
                  filter === c.key ? "text-white/80" : "text-slate-400 dark:text-slate-500"
                }`}
              >
                {c.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title={query ? "לא נמצאו עובדים תואמים" : "אין עובדים בקטגוריה זו"}
          subtitle={query ? "נסה/י מונח חיפוש אחר או בחר/י מסנן אחר." : undefined}
        />
      ) : (
        <EmployeeTable employees={filtered} />
      )}
    </div>
  );
}
