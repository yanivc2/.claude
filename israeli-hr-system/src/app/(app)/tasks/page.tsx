import { prisma } from "@/lib/prisma";
import { currentAdmin } from "@/lib/session";
import { employeeScope, canWriteEmployeeData } from "@/lib/rbac";
import { TasksManager } from "@/components/TasksManager";

export const metadata = { title: "משימות ונהלים" };
export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const me = await currentAdmin();
  const scope = me ? employeeScope(me) : { id: "__none__" };
  const employees = await prisma.employee
    .findMany({
      where: { status: { in: ["ACTIVE", "ONBOARDING", "NOTICE_PERIOD"] }, ...scope },
      orderBy: { firstName: "asc" },
      select: { id: true, firstName: true, lastName: true },
    })
    .catch(() => []);

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
          משימות ונהלים
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          יצירת משימות ונהלי משמרת ושיוכם לעובדים — עם התראה מיידית.
        </p>
      </header>
      <TasksManager
        employees={employees.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}` }))}
        canManageEmployees={!!me && canWriteEmployeeData(me)}
      />
    </div>
  );
}
