import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "לוח בקרה" };

// לוח בקרה ראשי — סקירה מהירה של שלושת המודולים.
export default async function DashboardPage() {
  const [activeEmployees, onboarding, dueSurveys, duePension, latestUpdate] = await Promise.all([
    prisma.employee.count({ where: { status: "ACTIVE" } }),
    prisma.employee.count({ where: { status: "ONBOARDING" } }),
    prisma.retentionSurvey.count({ where: { status: "SCHEDULED", scheduledFor: { lte: new Date() } } }),
    prisma.pensionTask.count({ where: { status: "PENDING", dueDate: { lte: new Date() } } }),
    prisma.legalUpdate.findFirst({ orderBy: { publishedAt: "desc" } }),
  ]).catch(() => [0, 0, 0, 0, null] as const);

  const cards = [
    { label: "בתהליך קליטה", value: onboarding, icon: "📝", href: "/employees" },
    { label: "עובדים פעילים", value: activeEmployees, icon: "👥", href: "/employees" },
    { label: "סקרים לביצוע", value: dueSurveys, icon: "🌱", href: "/retention" },
    { label: "תיקי פנסיה לפתיחה", value: duePension, icon: "🏦", href: "/employees" },
  ];

  return (
    <div>
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Link
          href="/legal-updates"
          className="rounded-xl border border-slate-200 bg-white p-6 transition hover:border-brand-300 hover:shadow-sm"
        >
          <h2 className="text-lg font-semibold text-slate-800">⚖️ עדכון חקיקה אחרון</h2>
          {latestUpdate ? (
            <p className="mt-2 text-sm text-slate-600">{latestUpdate.title}</p>
          ) : (
            <p className="mt-2 text-sm text-slate-400">אין עדכונים עדיין</p>
          )}
        </Link>

        <Link
          href="/consultation"
          className="rounded-xl border border-slate-200 bg-white p-6 transition hover:border-brand-300 hover:shadow-sm"
        >
          <h2 className="text-lg font-semibold text-slate-800">💬 התייעצות מהירה</h2>
          <p className="mt-2 text-sm text-slate-600">
            שאל/י את הצ'אטבוט שאלה על זכויות וחוקי עבודה בישראל.
          </p>
        </Link>
      </div>
    </div>
  );
}
