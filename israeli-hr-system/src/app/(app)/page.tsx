import Link from "next/link";
import { Users, UserPlus, Sprout, Landmark, ArrowLeft, Plus, type LucideIcon } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PensionAlert, type PensionAlertItem } from "@/components/PensionAlert";

export const dynamic = "force-dynamic";
export const metadata = { title: "לוח בקרה" };

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });
const todayFmt = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long" });

// צבע אווטאר דטרמיניסטי לפי שם (עקבי בין רינדורים).
const AVATARS = [
  "from-blue-500 to-blue-700",
  "from-sky-500 to-cyan-700",
  "from-violet-500 to-purple-700",
  "from-amber-500 to-orange-700",
  "from-emerald-500 to-teal-700",
  "from-rose-500 to-pink-700",
];
function avatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}
function initials(first: string, last: string): string {
  return ((first?.[0] ?? "") + (last?.[0] ?? "")).trim() || "עו";
}

const STATUS: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "פעיל", cls: "bg-green-50 text-green-700" },
  ONBOARDING: { label: "בקליטה", cls: "bg-brand-50 text-brand-700" },
  TERMINATED: { label: "הסתיים", cls: "bg-slate-100 text-slate-500" },
};

export default async function DashboardPage() {
  const now = new Date();
  const inTwoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const [activeEmployees, onboarding, dueSurveys, duePension, pensionSoon, recent] =
    await Promise.all([
      prisma.employee.count({ where: { status: "ACTIVE" } }),
      prisma.employee.count({ where: { status: "ONBOARDING" } }),
      prisma.retentionSurvey.count({ where: { status: "SCHEDULED", scheduledFor: { lte: now } } }),
      prisma.pensionTask.count({ where: { status: "PENDING", dueDate: { lte: now } } }),
      prisma.pensionTask.findMany({
        where: { status: "PENDING", dueDate: { lte: inTwoWeeks } },
        orderBy: { dueDate: "asc" },
        include: { employee: { select: { firstName: true, lastName: true } } },
      }),
      prisma.employee.findMany({
        orderBy: { startDate: "desc" },
        take: 5,
        select: { id: true, firstName: true, lastName: true, jobTitle: true, startDate: true, status: true },
      }),
    ]).catch(() => [0, 0, 0, 0, [], []] as const);

  const pensionAlerts: PensionAlertItem[] = pensionSoon.map((p) => ({
    id: p.employeeId,
    name: `${p.employee.firstName} ${p.employee.lastName}`,
    dueDate: dateFmt.format(p.dueDate),
    overdue: p.dueDate < now,
  }));

  const cards: {
    label: string;
    value: number;
    icon: LucideIcon;
    tone: "brand" | "good" | "warn";
    href: string;
    sub: string;
  }[] = [
    { label: "עובדים פעילים", value: activeEmployees, icon: Users, tone: "good", href: "/employees", sub: "מועסקים כרגע" },
    { label: "בתהליך קליטה", value: onboarding, icon: UserPlus, tone: "brand", href: "/employees", sub: "טרם הושלמו" },
    { label: "סקרי שימור לביצוע", value: dueSurveys, icon: Sprout, tone: "brand", href: "/retention", sub: "3 / 15 / 30 ימים" },
    { label: "תיקי פנסיה לפתיחה", value: duePension, icon: Landmark, tone: "warn", href: "/employees", sub: "חובה חוקית" },
  ];

  const toneChip = {
    brand: "bg-brand-50 text-brand-600",
    good: "bg-green-50 text-green-600",
    warn: "bg-amber-50 text-amber-600",
  };

  return (
    <div>
      <PensionAlert items={pensionAlerts} />

      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-800">לוח בקרה</h1>
          <p className="mt-1 text-sm text-slate-500">
            סקירה כללית של פעילות משאבי האנוש · {todayFmt.format(now)}
          </p>
        </div>
        <Link
          href="/onboarding"
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand-500/25 transition hover:brightness-105"
        >
          <Plus size={17} strokeWidth={2.6} />
          קליטת עובד חדש
        </Link>
      </div>

      {/* כרטיסי מדדים */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Link
              key={c.label}
              href={c.href}
              className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className={`grid h-10 w-10 place-items-center rounded-xl ${toneChip[c.tone]}`}>
                  <Icon size={20} />
                </span>
                <ArrowLeft
                  size={18}
                  className="text-slate-300 transition group-hover:-translate-x-0.5 group-hover:text-brand-400"
                />
              </div>
              <p className="mt-4 text-sm font-semibold text-slate-500">{c.label}</p>
              <p className="mt-0.5 text-3xl font-extrabold tabular-nums tracking-tight text-slate-800">
                {c.value}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">{c.sub}</p>
            </Link>
          );
        })}
      </div>

      {/* עובדים אחרונים + משימות פנסיה */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.55fr_1fr]">
        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="font-bold text-slate-800">עובדים אחרונים</h2>
            <Link href="/employees" className="text-sm font-semibold text-brand-600 hover:underline">
              לכל העובדים ←
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-slate-400">אין עדיין עובדים במערכת.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-5 py-2.5 text-start font-bold">עובד/ת</th>
                    <th className="px-5 py-2.5 text-start font-bold">תפקיד</th>
                    <th className="px-5 py-2.5 text-start font-bold">תחילת עבודה</th>
                    <th className="px-5 py-2.5 text-start font-bold">סטטוס</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => {
                    const st = STATUS[e.status] ?? { label: e.status, cls: "bg-slate-100 text-slate-500" };
                    return (
                      <tr key={e.id} className="border-t border-slate-100 transition hover:bg-slate-50">
                        <td className="px-5 py-3">
                          <Link href={`/employees/${e.id}`} className="flex items-center gap-3">
                            <span
                              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br text-xs font-bold text-white ${avatarColor(
                                e.firstName + e.lastName,
                              )}`}
                            >
                              {initials(e.firstName, e.lastName)}
                            </span>
                            <span className="font-semibold text-slate-800">
                              {e.firstName} {e.lastName}
                            </span>
                          </Link>
                        </td>
                        <td className="px-5 py-3 text-slate-500">{e.jobTitle || "—"}</td>
                        <td className="px-5 py-3 tabular-nums text-slate-500">
                          {dateFmt.format(e.startDate)}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${st.cls}`}>
                            {st.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="font-bold text-slate-800">משימות פנסיה קרובות</h2>
          </div>
          {pensionAlerts.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-slate-400">
              אין משימות פנסיה בשבועיים הקרובים. ✓
            </p>
          ) : (
            <ul className="p-2">
              {pensionAlerts.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/employees/${p.id}`}
                    className="flex items-center gap-3 rounded-xl p-3 transition hover:bg-slate-50"
                  >
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
                        p.overdue ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"
                      }`}
                    >
                      <Landmark size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-800">
                        פתיחת תיק פנסיה — {p.name}
                      </span>
                      <span className="block text-xs text-slate-400">חובה חוקית</span>
                    </span>
                    <span
                      className={`shrink-0 text-xs font-bold ${
                        p.overdue ? "text-red-600" : "text-amber-600"
                      }`}
                    >
                      {p.overdue ? "באיחור" : `עד ${p.dueDate}`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
