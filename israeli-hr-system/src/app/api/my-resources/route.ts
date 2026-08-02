import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { employeeFromRequest } from "@/lib/employee-auth";

// GET /api/my-resources — נהלים וסרטונים שאושרו, בהיקף החברה של העובד:
//   • פריטים ללא שיוך חברה (גלובליים), או
//   • פריטים המשויכים לחברה של העובד.
// מוחזר ללא תוכן הקובץ הכבד (fileData) — ההורדה דרך /api/resources/[id]/file.
export async function GET(req: Request) {
  const me = await employeeFromRequest(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const items = await prisma.resource
    .findMany({
      where: {
        status: "APPROVED",
        OR: [{ companyId: null }, { companyId: me.companyId ?? "__none__" }],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        kind: true,
        description: true,
        url: true,
        fileName: true,
        mimeType: true,
        createdAt: true,
      },
      take: 200,
    })
    .catch(() => []);

  return NextResponse.json(items);
}
