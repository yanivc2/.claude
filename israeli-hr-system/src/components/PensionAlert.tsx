"use client";

import { useState } from "react";
import Link from "next/link";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">🏦 תיקי פנסיה לפתיחה</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="סגירה"
            className="rounded-lg p-1 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          לעובדים הבאים יש לפתוח תיק פנסיה בשבועיים הקרובים:
        </p>
        <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-sm"
            >
              <Link href={`/employees/${it.id}`} className="font-medium text-brand-700 dark:text-brand-300 hover:underline">
                {it.name}
              </Link>
              <span className={it.overdue ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-400"}>
                {it.overdue ? "באיחור · " : "עד "}
                {it.dueDate}
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-4 w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
        >
          הבנתי
        </button>
      </div>
    </div>
  );
}
