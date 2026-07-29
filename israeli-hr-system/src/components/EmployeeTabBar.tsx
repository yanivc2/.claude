"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ListChecks, FileText, FolderOpen, Video, type LucideIcon } from "lucide-react";

const TABS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/my-home", label: "בית", icon: Home },
  { href: "/my-tasks", label: "משימות", icon: ListChecks },
  { href: "/my-form", label: "הטופס", icon: FileText },
  { href: "/my-resources", label: "נהלים", icon: FolderOpen },
  { href: "/my-videos", label: "סרטונים", icon: Video },
];

// סרגל טאבים תחתון לעובד (self-service). מוצג בכל רוחב — חוויית מובייל.
export function EmployeeTabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="ניווט עובד"
      className="glass fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-md items-stretch justify-around !border-x-0 !border-b-0 border-t border-slate-200/70 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 dark:border-slate-800"
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className="relative flex flex-1 flex-col items-center gap-1 py-1.5">
            {active && (
              <span aria-hidden className="absolute -top-1.5 h-1 w-8 rounded-full bg-gradient-to-l from-brand-500 to-accent-600" />
            )}
            <Icon
              size={23}
              strokeWidth={active ? 2.4 : 2}
              className={active ? "text-brand-600 dark:text-accent-300" : "text-slate-400 dark:text-slate-500"}
            />
            <span className={`text-[10.5px] font-bold ${active ? "text-brand-600 dark:text-accent-300" : "text-slate-400 dark:text-slate-500"}`}>
              {t.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
