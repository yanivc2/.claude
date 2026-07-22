import { prisma } from "@/lib/prisma";
import type { SurveyMilestone, SurveyStatus } from "@prisma/client";
import { daysUntilBirthday, birthdayWaHref } from "@/lib/birthday";

export const dynamic = "force-dynamic";
export const metadata = { title: "שימור עובדים" };

const birthdayFmt = new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit" });

// שמות ה-enum נשמרו, אך המרווחים בפועל הם 3/15/30 ימים.
const MILESTONE_LABELS: Record<SurveyMilestone, string> = {
  DAY_30: "3 ימים",
  DAY_60: "15 ימים",
  DAY_90: "30 ימים",
};

const STATUS_LABELS: Record<SurveyStatus, string> = {
  SCHEDULED: "מתוזמן",
  SENT: "נשלח",
  COMPLETED: "הושלם",
};

const STATUS_STYLES: Record<SurveyStatus, string> = {
  SCHEDULED: "bg-slate-100 text-slate-600",
  SENT: "bg-blue-50 text-blue-700",
  COMPLETED: "bg-green-50 text-green-700",
};

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });

export default async function RetentionPage() {
  const [surveys, employees] = await Promise.all([
    prisma.retentionSurvey
      .findMany({ orderBy: { scheduledFor: "asc" }, include: { employee: true }, take: 50 })
      .catch(() => []),
    prisma.employee
      .findMany({
        where: { status: { in: ["ACTIVE", "ONBOARDING", "NOTICE_PERIOD"] }, birthDate: { not: null } },
      })
      .catch(() => []),
  ]);

  // ימי הולדת בשבועיים הקרובים (כולל היום), ממוינים לפי קרבה.
  const now = new Date();
  const birthdays = employees
    .filter((e) => e.birthDate)
    .map((e) => ({ e, days: daysUntilBirthday(e.birthDate as Date, now) }))
    .filter((b) => b.days <= 14)
    .sort((a, b) => a.days - b.days);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800">שימור עובדים</h1>
        <p className="mt-1 text-sm text-slate-500">
          סקרי שביעות רצון (Pulse Surveys) מתוזמנים אוטומטית ל-3/15/30 ימים ממועד
          תחילת העבודה, לצד תזמון פגישות חתך למנהל הישיר.
        </p>
      </header>

      {/* ימי הולדת קרובים — ברכה בוואטסאפ בלחיצה */}
      {birthdays.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-400">
            🎂 ימי הולדת קרובים
          </h2>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {birthdays.map(({ e, days }) => {
              const href = birthdayWaHref(e.phone, e.firstName);
              return (
                <li
                  key={e.id}
                  className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <span className="text-sm font-medium text-slate-800">
                      {e.firstName} {e.lastName}
                    </span>
                    <span className="mr-2 text-xs text-slate-500">
                      {birthdayFmt.format(e.birthDate as Date)} ·{" "}
                      {days === 0 ? "היום! 🎉" : `בעוד ${days} ימים`}
                    </span>
                  </div>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-700"
                    >
                      📱 שליחת ברכה בוואטסאפ
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">אין טלפון</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {surveys.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          אין סקרים מתוזמנים. סקרים נוצרים אוטומטית בעת קליטת עובד חדש.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[32rem] text-start text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-5 py-3 text-start font-bold">עובד</th>
                <th className="px-5 py-3 text-start font-bold">אבן דרך</th>
                <th className="px-5 py-3 text-start font-bold">מתוזמן ל-</th>
                <th className="px-5 py-3 text-start font-bold">סטטוס</th>
                <th className="px-5 py-3 text-start font-bold">ציון</th>
              </tr>
            </thead>
            <tbody>
              {surveys.map((s) => (
                <tr key={s.id} className="border-t border-slate-100 transition hover:bg-slate-50">
                  <td className="px-5 py-3 font-semibold text-slate-800">
                    {s.employee.firstName} {s.employee.lastName}
                  </td>
                  <td className="px-5 py-3 text-slate-500">{MILESTONE_LABELS[s.milestone]}</td>
                  <td className="px-5 py-3 tabular-nums text-slate-500">{dateFmt.format(s.scheduledFor)}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_STYLES[s.status]}`}
                    >
                      {STATUS_LABELS[s.status]}
                    </span>
                  </td>
                  <td className="px-5 py-3 tabular-nums text-slate-500">{s.score ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
