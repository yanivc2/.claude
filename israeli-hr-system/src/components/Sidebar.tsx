"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// ניווט ראשי. הפריסה RTL — הסרגל ממוקם בצד ימין באופן טבעי.
const NAV = [
  { href: "/", label: "לוח בקרה", icon: "📊" },
  { href: "/legal-updates", label: "עדכוני חקיקה", icon: "⚖️" },
  { href: "/consultation", label: "התייעצות חוקים וזכויות", icon: "💬" },
  { href: "/onboarding", label: "קליטת עובד", icon: "📝" },
  { href: "/retention", label: "שימור עובדים", icon: "🌱" },
  { href: "/termination", label: "סיום העסקה", icon: "📄" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 shrink-0 border-l border-slate-200 bg-white">
      <div className="p-6">
        <h1 className="text-xl font-bold text-brand-700">מערכת משאבי אנוש</h1>
        <p className="mt-1 text-xs text-slate-500">מותאמת לשוק הישראלי</p>
      </div>
      <nav className="px-3">
        {NAV.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                active
                  ? "bg-brand-50 text-brand-700"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              <span aria-hidden>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
