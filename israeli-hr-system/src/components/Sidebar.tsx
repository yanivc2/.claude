"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// ניווט ראשי. הפריסה RTL — הסרגל ממוקם בצד ימין באופן טבעי.
// במחשב הסרגל קבוע; בסלולר הוא נסתר מאחורי כפתור המבורגר ונפתח כמגירה.
const NAV = [
  { href: "/", label: "לוח בקרה", icon: "📊" },
  { href: "/onboarding", label: "קליטת עובד", icon: "📝" },
  { href: "/termination", label: "סיום העסקה", icon: "📄" },
  { href: "/employees", label: "עובדים ותיקים", icon: "👥" },
  { href: "/retention", label: "שימור עובדים", icon: "🌱" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // סגירת המגירה אוטומטית בעת מעבר בין עמודים.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // מניעת גלילת הרקע כשהמגירה פתוחה (סלולר).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      {/* סרגל עליון — מוצג בסלולר בלבד. כפתור ההמבורגר בצד ימין (RTL). */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="פתיחת תפריט"
          aria-expanded={open}
          className="-mr-1 rounded-lg p-2 text-slate-600 transition hover:bg-slate-100"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M4 6h16M4 12h16M4 18h16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <span className="text-lg font-bold text-brand-700">מערכת משאבי אנוש</span>
      </header>

      {/* רקע כהה מאחורי המגירה — סלולר בלבד */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* סרגל הצד / מגירה */}
      <aside
        className={`fixed inset-y-0 right-0 z-40 w-64 shrink-0 transform border-l border-slate-200 bg-white transition-transform duration-200 ease-out md:static md:z-auto md:transform-none ${
          open ? "translate-x-0" : "translate-x-full"
        } md:translate-x-0`}
      >
        <div className="flex items-start justify-between p-6">
          <div>
            <h1 className="text-2xl font-bold text-brand-700">מערכת משאבי אנוש</h1>
            <p className="mt-1 text-sm text-slate-500">מותאמת לשוק הישראלי</p>
          </div>
          {/* כפתור סגירה — סלולר בלבד */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="סגירת תפריט"
            className="-mr-1 rounded-lg p-1 text-slate-500 transition hover:bg-slate-100 md:hidden"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <nav className="px-3 pb-6">
          {NAV.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-base font-medium transition ${
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                <span className="text-lg" aria-hidden>
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}

          <button
            type="button"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/login";
            }}
            className="mt-2 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-base font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
          >
            <span className="text-lg" aria-hidden>
              🚪
            </span>
            <span>יציאה</span>
          </button>
        </nav>
      </aside>
    </>
  );
}
