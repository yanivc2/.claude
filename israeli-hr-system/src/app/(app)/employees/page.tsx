import Link from "next/link";
import { prisma } from "@/lib/prisma";
import type { Employee, EmploymentStatus } from "@prisma/client";
import { EmployeeRowActions } from "@/components/EmployeeRowActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "עובדים ותיקים" };

const STATUS_LABELS: Record<EmploymentStatus, string> = {
  ONBOARDING: "בתהליך קליטה",
  ACTIVE: "פעיל",
  NOTICE_PERIOD: "בהודעה מוקדמת",
  INACTIVE: "לא פעיל",
  TERMINATED: "סיום העסקה",
};

const STATUS_STYLES: Record<EmploymentStatus, string> = {
  ONBOARDING: "bg-amber-50 text-amber-700",
  ACTIVE: "bg-green-50 text-green-700",
  NOTICE_PERIOD: "bg-orange-50 text-orange-700",
  INACTIVE: "bg-slate-100 text-slate-500",
  TERMINATED: "bg-slate-100 text-slate-500",
};

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });
const INACTIVE_STATUSES: EmploymentStatus[] = ["INACTIVE", "TERMINATED"];

function EmployeeTable({ employees }: { employees: Employee[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[42rem] text-start text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-4 py-3 text-start font-medium">שם</th>
            <th className="px-4 py-3 text-start font-medium">תפקיד</th>
            <th className="px-4 py-3 text-start font-medium">תחילת עבודה</th>
            <th className="px-4 py-3 text-start font-medium">סטטוס</th>
            <th className="px-4 py-3 text-start font-medium">פעולות</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {employees.map((e) => (
            <tr key={e.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-800">
                <Link href={`/employees/${e.id}`} className="hover:underline">
                  {e.firstName} {e.lastName}
                </Link>
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
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/employees/${e.id}`}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-50"
                  >
                    פתיחת תיק
                  </Link>
                  <EmployeeRowActions
                    id={e.id}
                    name={`${e.firstName} ${e.lastName}`}
                    isInactive={INACTIVE_STATUSES.includes(e.status)}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function EmployeesPage() {
  const employees = await prisma.employee
    .findMany({ orderBy: { createdAt: "desc" }, take: 300 })
    .catch(() => []);

  const active = employees.filter((e) => !INACTIVE_STATUSES.includes(e.status));
  const inactive = employees.filter((e) => INACTIVE_STATUSES.includes(e.status));

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-800">עובדים ותיקים</h1>
        <p className="mt-1 text-sm text-slate-500">
          לחיצה על עובד פותחת את התיק המלא. ניתן להעביר עובד ל&ldquo;לא פעיל&rdquo; או למחוק.
        </p>
      </header>

      {employees.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          אין עובדים במערכת עדיין. קלט/י עובד חדש בעמוד &ldquo;קליטת עובד&rdquo;.
        </p>
      ) : (
        <>
          <section>
            <h2 className="mb-3 text-lg font-semibold text-slate-800">עובדים פעילים</h2>
            {active.length ? (
              <EmployeeTable employees={active} />
            ) : (
              <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400">
                אין עובדים פעילים.
              </p>
            )}
          </section>

          {inactive.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-slate-800">עובדים לא פעילים</h2>
              <EmployeeTable employees={inactive} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
