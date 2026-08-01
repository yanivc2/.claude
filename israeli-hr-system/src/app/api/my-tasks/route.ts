import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { employeeFromRequest } from "@/lib/employee-auth";

// GET /api/my-tasks — המשימות המוקצות לעובד המחובר:
//   • משימות המשויכות ישירות אליו (employeeId), או
//   • משימות scope=ALL/TEAM של החברה שלו.
export async function GET(req: Request) {
  const me = await employeeFromRequest(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const tasks = await prisma.task.findMany({
    where: {
      OR: [
        { employeeId: me.id },
        { employeeIds: { has: me.id } },
        { assigneeScope: { in: ["ALL", "TEAM"] }, companyId: me.companyId },
      ],
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
  });
  return NextResponse.json(tasks);
}
