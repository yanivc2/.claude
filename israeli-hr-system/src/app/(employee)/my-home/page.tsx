import Link from "next/link";
import { ListChecks, FileText, FolderOpen, Video, ChevronLeft } from "lucide-react";
import { currentEmployee } from "@/lib/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "האזור שלי" };

// דף הבית של העובד — ברכה, כמות משימות פתוחות, וקיצורי דרך.
export default async function MyHomePage() {
  const me = await currentEmployee();
  if (!me) return null;

  const [openTasks, company] = await Promise.all([
    prisma.task.count({
      where: {
        status: "SENT",
        OR: [
          { employeeId: me.id },
          { assigneeScope: { in: ["ALL", "TEAM"] }, companyId: me.companyId },
        ],
      },
    }),
    me.companyId
      ? prisma.company.findUnique({ where: { id: me.companyId }, select: { name: true } })
      : Promise.resolve(null),
  ]);

  const links = [
    { href: "/my-tasks", label: "המשימות שלי", desc: "משימות ונהלי משמרת", icon: ListChecks },
    { href: "/my-form", label: "טופס 101 שלי", desc: "הפרטים שמסרתי", icon: FileText },
    { href: "/my-resources", label: "נהלים ומסמכים", desc: "חומרים לעיון", icon: FolderOpen },
    { href: "/my-videos", label: "סרטוני הדרכה", desc: "צפייה בהדרכות", icon: Video },
  ];

  return (
    <div className="space-y-5 py-2">
      {/* כרטיס ברכה */}
      <section className="animate-fade-up overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 to-accent-600 p-6 text-white shadow-glow">
        <p className="text-sm/relaxed text-white/80">שלום,</p>
        <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight">
          {me.firstName} {me.lastName}
        </h1>
        {company?.name && <p className="mt-1 text-sm text-white/80">{company.name}</p>}
        <Link
          href="/my-tasks"
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/20 px-4 py-2 text-sm font-bold backdrop-blur transition hover:bg-white/30"
        >
          <ListChecks size={17} />
          {openTasks > 0 ? `${openTasks} משימות ממתינות` : "אין משימות פתוחות"}
        </Link>
      </section>

      {/* קיצורי דרך */}
      <div className="grid grid-cols-1 gap-3 animate-stagger">
        {links.map((l, i) => {
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              style={{ "--i": i } as React.CSSProperties}
              className="hover-lift flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white/70 p-4 shadow-card backdrop-blur dark:border-slate-800 dark:bg-slate-900/60"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500/15 to-accent-500/15 text-brand-600 dark:text-accent-300">
                <Icon size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-slate-800 dark:text-slate-100">{l.label}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">{l.desc}</span>
              </span>
              <ChevronLeft size={18} className="shrink-0 text-slate-400" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
