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
  Settings,
  LogOut,
  Menu,
  X,
  Briefcase,
  type LucideIcon,
} from "lucide-react";

// ניווט ראשי. הפריסה RTL — הסרגל ממוקם בצד ימין באופן טבעי.
// במחשב הסרגל קבוע; בסלולר הוא נסתר מאחורי כפתור המבורגר ונפתח כמגירה.
const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "לוח בקרה", icon: LayoutDashboard },
  { href: "/onboarding", label: "קליטת עובד", icon: UserPlus },
  { href: "/termination", label: "סיום העסקה", icon: FileX2 },
  { href: "/employees", label: "עובדים ותיקים", icon: Users },
  { href: "/retention", label: "שימור עובדים", icon: Sprout },
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
        ? "bg-brand-50 text-brand-800"
        : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
    }`;

  return (
    <>
      {/* סרגל עליון — סלולר בלבד */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="פתיחת תפריט"
          aria-expanded={open}
          className="-mr-1 rounded-lg p-2 text-slate-600 transition hover:bg-slate-100"
        >
          <Menu size={24} />
        </button>
        <span className="flex items-center gap-2 font-bold text-slate-800">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white">
            <Briefcase size={17} />
          </span>
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
        className={`fixed inset-y-0 right-0 z-40 flex w-64 shrink-0 transform flex-col border-l border-slate-200 bg-white transition-transform duration-200 ease-out md:static md:z-auto md:transform-none ${
          open ? "translate-x-0" : "translate-x-full"
        } md:translate-x-0`}
      >
        {/* לוגו */}
        <div className="flex items-center justify-between px-5 py-5">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-lg shadow-brand-500/25">
              <Briefcase size={22} />
            </span>
            <div>
              <p className="text-base font-extrabold leading-tight text-slate-800">משאבי אנוש</p>
              <p className="text-xs font-semibold text-slate-400">מערכת ניהול HR</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="סגירת תפריט"
            className="rounded-lg p-1 text-slate-500 transition hover:bg-slate-100 md:hidden"
          >
            <X size={22} />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3">
          <p className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
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

          <p className="px-3 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            מערכת
          </p>
          <Link href="/settings" className={linkClass(pathname.startsWith("/settings"))}>
            <Settings size={20} className={pathname.startsWith("/settings") ? "" : "opacity-90"} />
            <span>הגדרות</span>
          </Link>
          <button
            type="button"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/login";
            }}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
          >
            <LogOut size={20} className="opacity-90" />
            <span>יציאה</span>
          </button>
        </nav>

        {/* כרטיס משתמש */}
        <div className="p-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white">
              {me ? initials(me.name) : "…"}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-800">{me?.name ?? "טוען…"}</p>
              <p className="text-xs text-slate-400">{me?.isOwner ? "בעל המערכת" : "משתמש"}</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
