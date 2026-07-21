import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PensionAlert, type PensionAlertItem } from "@/components/PensionAlert";

export const dynamic = "force-dynamic";
export const metadata = { title: "לוח בקרה" };

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });

// לוח בקרה ראשי — סקירה מהירה של המודולים.
export default async function DashboardPage() {
  const now = new Date();
  const inTwoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const [activeEmployees, onboarding, dueSurveys, duePension, pensionSoon] = await Promise.all([
    prisma.employee.count({ where: { status: "ACTIVE" } }),
    prisma.employee.count({ where: { status: "ONBOARDING" } }),
    prisma.retentionSurvey.count({ where: { status: "SCHEDULED", scheduledFor: { lte: now } } }),
    prisma.pensionTask.count({ where: { status: "PENDING", dueDate: { lte: now } } }),
    // עובדים שיש לפתוח להם תיק פנסיה בשבועיים הקרובים (או באיחור).
    prisma.pensionTask.findMany({
      where: { status: "PENDING", dueDate: { lte: inTwoWeeks } },
      orderBy: { dueDate: "asc" },
      include: { employee: { select: { firstName: true, lastName: true } } },
    }),
  ]).catch(() => [0, 0, 0, 0, []] as const);

  const pensionAlerts: PensionAlertItem[] = pensionSoon.map((p) => ({
    id: p.employeeId,
    name: `${p.employee.firstName} ${p.employee.lastName}`,
    dueDate: dateFmt.format(p.dueDate),
    overdue: p.dueDate < now,
  }));

  const cards = [
    { label: "בתהליך קליטה", value: onboarding, icon: "📝", href: "/employees" },
    { label: "עובדים פעילים", value: activeEmployees, icon: "👥", href: "/employees" },
    { label: "סקרים לביצוע", value: dueSurveys, icon: "🌱", href: "/retention" },
    { label: "תיקי פנסיה לפתיחה", value: duePension, icon: "🏦", href: "/employees" },
  ];

  return (
    <div>
      <PensionAlert items={pensionAlerts} />

      <header className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800">לוח בקרה</h1>
        <p className="mt-1 text-sm text-slate-500">סקירה כללית של פעילות משאבי האנוש</p>
      </header>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* פעולה מהירה: קליטת עובד חדש */}
        <Link
          href="/onboarding"
          className="flex flex-col justify-between rounded-xl border border-brand-200 bg-brand-50 p-6 transition hover:border-brand-300 hover:bg-brand-100"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-brand-700">קליטת עובד</span>
            <span className="text-2xl" aria-hidden>
              ➕
            </span>
          </div>
          <p className="mt-2 text-lg font-bold text-brand-700">קליטת עובד חדש</p>
        </Link>

        {cards.map((c) => (
          <Link
            key={c.label}
            href={c.href}
            className="rounded-xl border border-slate-200 bg-white p-6 transition hover:border-brand-300 hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">{c.label}</span>
              <span className="text-2xl" aria-hidden>
                {c.icon}
              </span>
            </div>
            <p className="mt-2 text-3xl font-bold text-slate-800">{c.value}</p>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4">
        <Link
          href="/consultation"
          className="rounded-xl border border-slate-200 bg-white p-6 transition hover:border-brand-300 hover:shadow-sm"
        >
          <h2 className="text-lg font-semibold text-slate-800">💬 יועץ לזכויות עובדים</h2>
          <p className="mt-2 text-sm text-slate-600">
            שאל/י את היועץ שאלה על זכויות וחוקי עבודה בישראל.
          </p>
        </Link>
      </div>
    </div>
  );
}
