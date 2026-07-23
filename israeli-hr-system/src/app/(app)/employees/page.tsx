import Link from "next/link";
import { UserPlus } from "lucide-react";
import { prisma } from "@/lib/prisma";
import type { Employee, EmploymentStatus } from "@prisma/client";
import { EmployeeRowActions } from "@/components/EmployeeRowActions";
import { avatarColor, initials } from "@/lib/avatar";

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
  ONBOARDING: "bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
  ACTIVE: "bg-green-50 dark:bg-green-500/15 text-green-700 dark:text-green-400",
  NOTICE_PERIOD: "bg-orange-50 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300",
  INACTIVE: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400",
  TERMINATED: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400",
};

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });
const INACTIVE_STATUSES: EmploymentStatus[] = ["INACTIVE", "TERMINATED"];

function EmployeeTable({ employees }: { employees: Employee[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
      <table className="w-full min-w-[42rem] text-start text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-400">
            <th className="px-5 py-3 text-start font-bold">שם</th>
            <th className="px-5 py-3 text-start font-bold">תפקיד</th>
            <th className="px-5 py-3 text-start font-bold">תחילת עבודה</th>
            <th className="px-5 py-3 text-start font-bold">סטטוס</th>
            <th className="px-5 py-3 text-start font-bold">פעולות</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => (
            <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800 transition hover:bg-slate-50 dark:hover:bg-slate-800/60">
              <td className="px-5 py-3">
                <Link href={`/employees/${e.id}`} className="flex items-center gap-3">
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br text-xs font-bold text-white ${avatarColor(
                      e.firstName + e.lastName,
                    )}`}
                  >
                    {initials(e.firstName, e.lastName)}
                  </span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {e.firstName} {e.lastName}
                  </span>
                </Link>
              </td>
              <td className="px-5 py-3 text-slate-500 dark:text-slate-400">{e.jobTitle || "—"}</td>
              <td className="px-5 py-3 tabular-nums text-slate-500 dark:text-slate-400">{dateFmt.format(e.startDate)}</td>
              <td className="px-5 py-3">
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_STYLES[e.status]}`}
                >
                  {STATUS_LABELS[e.status]}
                </span>
              </td>
              <td className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/employees/${e.id}`}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300 transition hover:border-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10"
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">עובדים ותיקים</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {employees.length > 0
              ? `${active.length} פעילים${inactive.length ? ` · ${inactive.length} לא פעילים` : ""}`
              : "לחיצה על עובד פותחת את התיק המלא."}
          </p>
        </div>
        <Link
          href="/onboarding"
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand-500/25 transition hover:brightness-105"
        >
          <UserPlus size={17} />
          קליטת עובד חדש
        </Link>
      </div>

      {employees.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          אין עובדים במערכת עדיין. קלט/י עובד חדש בעמוד &ldquo;קליטת עובד&rdquo;.
        </p>
      ) : (
        <>
          <section>
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-400 dark:text-slate-400">
              עובדים פעילים
            </h2>
            {active.length ? (
              <EmployeeTable employees={active} />
            ) : (
              <p className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-400 dark:text-slate-400">
                אין עובדים פעילים.
              </p>
            )}
          </section>

          {inactive.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-400 dark:text-slate-400">
                עובדים לא פעילים
              </h2>
              <EmployeeTable employees={inactive} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
