"use client";

import { useState } from "react";
import Link from "next/link";
import { Landmark, X, ChevronLeft } from "lucide-react";

export interface PensionAlertItem {
  id: string;
  name: string;
  dueDate: string; // מפורמט מראש (he-IL)
  overdue: boolean;
}

// הודעה קופצת בכניסה לאפליקציה: עובדים שיש לפתוח להם תיק פנסיה בשבועיים הקרובים.
export function PensionAlert({ items }: { items: PensionAlertItem[] }) {
  const [open, setOpen] = useState(items.length > 0);
  if (!open || items.length === 0) return null;

  const overdueCount = items.filter((i) => i.overdue).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
            <Landmark size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold leading-tight text-slate-800 dark:text-slate-100">
              תיקי פנסיה לפתיחה
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {overdueCount > 0
                ? `${overdueCount} באיחור · חובה חוקית לפתוח בהקדם`
                : "יש לפתוח תיק בשבועיים הקרובים — חובה חוקית"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="סגירה"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 dark:text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X size={18} />
          </button>
        </div>
        <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto">
          {items.map((it) => (
            <li key={it.id}>
              <Link
                href={`/employees/${it.id}`}
                onClick={() => setOpen(false)}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2.5 text-sm transition hover:border-brand-300 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <span className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100">
                  {it.name}
                  <ChevronLeft size={15} className="text-slate-300 dark:text-slate-600" />
                </span>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${
                    it.overdue
                      ? "bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400"
                      : "bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  {it.overdue ? "באיחור" : `עד ${it.dueDate}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-4 w-full rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand-500/25 transition hover:brightness-105"
        >
          הבנתי
        </button>
      </div>
    </div>
  );
}
