import { prisma } from "@/lib/prisma";
import type { SurveyMilestone, SurveyStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

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
  const surveys = await prisma.retentionSurvey
    .findMany({
      orderBy: { scheduledFor: "asc" },
      include: { employee: true },
      take: 50,
    })
    .catch(() => []);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">שימור עובדים</h1>
        <p className="mt-1 text-sm text-slate-500">
          סקרי שביעות רצון (Pulse Surveys) מתוזמנים אוטומטית ל-3/15/30 ימים ממועד
          תחילת העבודה, לצד תזמון פגישות חתך למנהל הישיר.
        </p>
      </header>

      {surveys.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          אין סקרים מתוזמנים. סקרים נוצרים אוטומטית בעת קליטת עובד חדש.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[32rem] text-start text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 text-start font-medium">עובד</th>
                <th className="px-4 py-3 text-start font-medium">אבן דרך</th>
                <th className="px-4 py-3 text-start font-medium">מתוזמן ל-</th>
                <th className="px-4 py-3 text-start font-medium">סטטוס</th>
                <th className="px-4 py-3 text-start font-medium">ציון</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {surveys.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3 text-slate-800">
                    {s.employee.firstName} {s.employee.lastName}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{MILESTONE_LABELS[s.milestone]}</td>
                  <td className="px-4 py-3 text-slate-600">{dateFmt.format(s.scheduledFor)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[s.status]}`}
                    >
                      {STATUS_LABELS[s.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{s.score ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
