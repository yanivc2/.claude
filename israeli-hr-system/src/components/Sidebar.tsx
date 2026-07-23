"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  UserPlus,
  FileX2,
  Users,
  Sprout,
  FolderOpen,
  Scale,
  Gavel,
  Settings,
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";

// לוגו האפליקציה (רשת אנשים). גרסה על רקע לבן — בולטת גם במצב בהיר וגם כהה.
function Logo({ size }: { size: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo-light.png"
      alt="לוגו"
      width={size}
      height={size}
      className="rounded-xl object-cover ring-1 ring-slate-200 dark:ring-slate-700"
    />
  );
}

// ניווט ראשי. הפריסה RTL — הסרגל ממוקם בצד ימין באופן טבעי.
// במחשב הסרגל קבוע; בסלולר הוא נסתר מאחורי כפתור המבורגר ונפתח כמגירה.
const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "לוח בקרה", icon: LayoutDashboard },
  { href: "/onboarding", label: "קליטת עובד", icon: UserPlus },
  { href: "/termination", label: "סיום העסקה", icon: FileX2 },
  { href: "/employees", label: "עובדים ותיקים", icon: Users },
  { href: "/retention", label: "שימור עובדים", icon: Sprout },
  { href: "/resources", label: "מסמכים ונהלים", icon: FolderOpen },
];

// ידע ומשפט — יועץ AI ועדכוני חקיקה.
const KNOWLEDGE_NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/consultation", label: "יועץ לזכויות עובדים", icon: Scale },
  { href: "/legal-updates", label: "עדכוני חקיקה", icon: Gavel },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).trim() || "מ";
}

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<{ name: string; isOwner: boolean } | null>(null);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setMe({ name: d.name, isOwner: d.isOwner }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const linkClass = (active: boolean) =>
    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
      active
        ? "bg-brand-50 dark:bg-brand-500/15 text-brand-800 dark:text-brand-200"
        : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-800 dark:hover:text-slate-100"
    }`;

  return (
    <>
      {/* סרגל עליון — סלולר בלבד */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="פתיחת תפריט"
          aria-expanded={open}
          className="-mr-1 rounded-lg p-2 text-slate-600 dark:text-slate-300 transition hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <Menu size={24} />
        </button>
        <span className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-100">
          <Logo size={32} />
          משאבי אנוש
        </span>
      </header>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`fixed inset-y-0 right-0 z-40 flex w-64 shrink-0 transform flex-col border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 transition-transform duration-200 ease-out md:static md:z-auto md:transform-none ${
          open ? "translate-x-0" : "translate-x-full"
        } md:translate-x-0`}
      >
        {/* לוגו */}
        <div className="flex items-center justify-between px-5 py-5">
          <div className="flex items-center gap-3">
            <Logo size={44} />
            <div>
              <p className="text-base font-extrabold leading-tight text-slate-800 dark:text-slate-100">משאבי אנוש</p>
              <p className="text-xs font-semibold text-slate-400 dark:text-slate-400">מערכת ניהול HR</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="סגירת תפריט"
            className="rounded-lg p-1 text-slate-500 dark:text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-800 md:hidden"
          >
            <X size={22} />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3">
          <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-400">
            ניהול
          </p>
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link key={item.href} href={item.href} className={linkClass(active)}>
                <Icon size={20} className={active ? "" : "opacity-90"} />
                <span>{item.label}</span>
              </Link>
            );
          })}

          <p className="px-3 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-400">
            ידע ומשפט
          </p>
          {KNOWLEDGE_NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link key={item.href} href={item.href} className={linkClass(active)}>
                <Icon size={20} className={active ? "" : "opacity-90"} />
                <span>{item.label}</span>
              </Link>
            );
          })}

          <p className="px-3 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-400">
            מערכת
          </p>
          <Link href="/settings" className={linkClass(pathname.startsWith("/settings"))}>
            <Settings size={20} className={pathname.startsWith("/settings") ? "" : "opacity-90"} />
            <span>הגדרות</span>
          </Link>
          <ThemeToggle />
          <button
            type="button"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/login";
            }}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500 dark:text-slate-400 transition hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-800 dark:hover:text-slate-100"
          >
            <LogOut size={20} className="opacity-90" />
            <span>יציאה</span>
          </button>
        </nav>

        {/* כרטיס משתמש */}
        <div className="p-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white">
              {me ? initials(me.name) : "…"}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-800 dark:text-slate-100">{me?.name ?? "טוען…"}</p>
              <p className="text-xs text-slate-400 dark:text-slate-400">{me?.isOwner ? "בעל המערכת" : "משתמש"}</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
