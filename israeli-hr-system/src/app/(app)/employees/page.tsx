import Link from "next/link";
import { UserPlus, Users } from "lucide-react";
import { prisma } from "@/lib/prisma";
import type { EmploymentStatus } from "@prisma/client";
import { EmployeesList, type EmployeeRow } from "@/components/EmployeesList";
import { EmptyState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";
export const metadata = { title: "עובדים ותיקים" };

const INACTIVE_STATUSES: EmploymentStatus[] = ["INACTIVE", "TERMINATED"];

export default async function EmployeesPage() {
  const employees = await prisma.employee
    .findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        nationalId: true,
        startDate: true,
        status: true,
      },
    })
    .catch(() => []);

  // המרה לצורה סריאליזבילית עבור רכיב הלקוח (תאריך כמחרוזת ISO).
  const rows: EmployeeRow[] = employees.map((e) => ({
    ...e,
    startDate: e.startDate.toISOString(),
  }));

  const activeCount = rows.filter((e) => !INACTIVE_STATUSES.includes(e.status)).length;
  const inactiveCount = rows.length - activeCount;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
            עובדים ותיקים
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {rows.length > 0
              ? `${activeCount} מועסקים${inactiveCount ? ` · ${inactiveCount} לא פעילים` : ""}`
              : "לחיצה על עובד פותחת את התיק המלא."}
          </p>
        </div>
        <Link
          href="/onboarding"
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105"
        >
          <UserPlus size={17} />
          קליטת עובד חדש
        </Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="אין עדיין עובדים במערכת"
          subtitle="קלוט/י את העובד הראשון — שלח/י לו קישור למילוי עצמי או מלא/י ידנית."
          action={
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105"
            >
              <UserPlus size={17} />
              קליטת עובד חדש
            </Link>
          }
        />
      ) : (
        <EmployeesList employees={rows} />
      )}
    </div>
  );
}
