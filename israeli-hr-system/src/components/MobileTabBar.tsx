"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  UserPlus,
  FileX2,
  Gavel,
  Scale,
  ListChecks,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useViewer } from "./ViewerProvider";

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
}

// טאבים לפי תפקיד. עובד (self-service) יתווסף בשלב חוויית העובד.
const MANAGER_TABS: Tab[] = [
  { href: "/", label: "בית", icon: LayoutDashboard },
  { href: "/assistant", label: "עוזר", icon: Sparkles },
  { href: "/tasks", label: "משימות", icon: ListChecks },
  { href: "/onboarding", label: "קליטה", icon: UserPlus },
  { href: "/termination", label: "סיום", icon: FileX2 },
  { href: "/legal-updates", label: "חקיקה", icon: Gavel },
  { href: "/consultation", label: "יועץ", icon: Scale },
];

// מנהל חנות — צפייה בלבד פרט לסיום; ללא קליטה.
const STORE_MANAGER_TABS: Tab[] = [
  { href: "/", label: "בית", icon: LayoutDashboard },
  { href: "/assistant", label: "עוזר", icon: Sparkles },
  { href: "/tasks", label: "משימות", icon: ListChecks },
  { href: "/termination", label: "סיום", icon: FileX2 },
  { href: "/legal-updates", label: "חקיקה", icon: Gavel },
  { href: "/consultation", label: "יועץ", icon: Scale },
];

// סרגל טאבים תחתון — סלולר בלבד (md:hidden). מחליף את מגירת הניווט.
export function MobileTabBar() {
  const pathname = usePathname();
  const { role } = useViewer();
  const tabs = role === "STORE_MANAGER" ? STORE_MANAGER_TABS : MANAGER_TABS;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav
      aria-label="ניווט ראשי"
      className="glass fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around !border-x-0 !border-b-0 border-t border-slate-200/70 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 dark:border-slate-800 md:hidden"
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = isActive(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className="group relative flex flex-1 flex-col items-center gap-1 py-1.5"
          >
            {active && (
              <span
                aria-hidden
                className="absolute -top-1.5 h-1 w-8 rounded-full bg-gradient-to-l from-brand-500 to-accent-600"
              />
            )}
            <Icon
              size={23}
              strokeWidth={active ? 2.4 : 2}
              className={
                active
                  ? "text-brand-600 dark:text-accent-300"
                  : "text-slate-400 dark:text-slate-500"
              }
            />
            <span
              className={`text-[10.5px] font-bold ${
                active
                  ? "text-brand-600 dark:text-accent-300"
                  : "text-slate-400 dark:text-slate-500"
              }`}
            >
              {t.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
