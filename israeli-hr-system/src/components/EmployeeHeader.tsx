"use client";

import { LogOut } from "lucide-react";
import { NotificationBell } from "./NotificationBell";

// סרגל עליון לעובד — לוגו, פעמון התראות, ויציאה.
export function EmployeeHeader({ name }: { name: string }) {
  return (
    <header className="glass fixed inset-x-0 top-0 z-30 mx-auto flex max-w-md items-center justify-between !border-x-0 !border-t-0 border-b border-slate-200/70 px-4 py-2.5 dark:border-slate-800">
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-light.png" alt="" width={28} height={28} className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-700" />
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">שלום, {name}</span>
      </div>
      <div className="flex items-center gap-1">
        <NotificationBell />
        <button
          type="button"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
          }}
          aria-label="יציאה"
          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          <LogOut size={19} />
        </button>
      </div>
    </header>
  );
}
