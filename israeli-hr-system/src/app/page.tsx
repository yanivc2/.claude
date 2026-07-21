import Link from "next/link";
import { prisma } from "@/lib/prisma";

// לוח בקרה ראשי — סקירה מהירה של שלושת המודולים.
export default async function DashboardPage() {
  const [activeEmployees, onboarding, dueSurveys, latestUpdate] = await Promise.all([
    prisma.employee.count({ where: { status: "ACTIVE" } }),
    prisma.employee.count({ where: { status: "ONBOARDING" } }),
    prisma.retentionSurvey.count({ where: { status: "SCHEDULED", scheduledFor: { lte: new Date() } } }),
    prisma.legalUpdate.findFirst({ orderBy: { publishedAt: "desc" } }),
  ]).catch(() => [0, 0, 0, null] as const);

  const cards = [
    { label: "עובדים פעילים", value: activeEmployees, icon: "👥" },
    { label: "בתהליך קליטה", value: onboarding, icon: "📝" },
    { label: "סקרים לביצוע", value: dueSurveys, icon: "🌱" },
  ];

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800">לוח בקרה</h1>
        <p className="mt-1 text-sm text-slate-500">סקירה כללית של פעילות משאבי האנוש</p>
      </header>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">{c.label}</span>
              <span className="text-2xl" aria-hidden>
                {c.icon}
              </span>
            </div>
            <p className="mt-2 text-3xl font-bold text-slate-800">{c.value}</p>
          </div>
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
