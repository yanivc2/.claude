import Link from "next/link";
import { prisma } from "@/lib/prisma";
import type { EmploymentStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<EmploymentStatus, string> = {
  ONBOARDING: "בתהליך קליטה",
  ACTIVE: "פעיל",
  NOTICE_PERIOD: "בהודעה מוקדמת",
  TERMINATED: "סיום העסקה",
};

const STATUS_STYLES: Record<EmploymentStatus, string> = {
  ONBOARDING: "bg-amber-50 text-amber-700",
  ACTIVE: "bg-green-50 text-green-700",
  NOTICE_PERIOD: "bg-orange-50 text-orange-700",
  TERMINATED: "bg-slate-100 text-slate-500",
};

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });

export default async function EmployeesPage() {
  const employees = await prisma.employee
    .findMany({ orderBy: { createdAt: "desc" }, take: 200 })
    .catch(() => []);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">עובדים ותיקים</h1>
        <p className="mt-1 text-sm text-slate-500">
          כל העובדים שנקלטו. לחיצה על עובד פותחת את התיק המלא — טופס 101, מסמכים, חתימות
          ותיק פנסיה.
        </p>
      </header>

      {employees.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          אין עובדים במערכת עדיין. קלט/י עובד חדש בעמוד &ldquo;קליטת עובד&rdquo;.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[36rem] text-start text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 text-start font-medium">שם</th>
                <th className="px-4 py-3 text-start font-medium">תפקיד</th>
                <th className="px-4 py-3 text-start font-medium">תחילת עבודה</th>
                <th className="px-4 py-3 text-start font-medium">סטטוס</th>
                <th className="px-4 py-3 text-start font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {employees.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">
                    {e.firstName} {e.lastName}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{e.jobTitle || "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{dateFmt.format(e.startDate)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[e.status]}`}
                    >
                      {STATUS_LABELS[e.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/employees/${e.id}`}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-50"
                    >
                      פתיחת תיק
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
