import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireWriter, employeeScope } from "@/lib/rbac";

// GET /api/employees — רשימת עובדים פעילים (id + שם) לשיוך משימות/נהלים.
// מסונן לפי היקף החברה של המשתמש (מנהל חנות — החברה שלו בלבד).
export async function GET(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const employees = await prisma.employee
    .findMany({
      where: { status: { in: ["ACTIVE", "ONBOARDING", "NOTICE_PERIOD"] }, ...employeeScope(me) },
      orderBy: { firstName: "asc" },
      select: { id: true, firstName: true, lastName: true },
    })
    .catch(() => []);
  return NextResponse.json(employees.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}` })));
}

// הקמת עובד מהירה — פרטי המינימום הדרושים כדי שיהיה ניתן לשייך אליו משימות.
// קליטה מלאה (טופס 101, מסמכים, זמינות) נעשית במסך קליטת העובד.
const schema = z.object({
  firstName: z.string().trim().min(1, "יש להזין שם פרטי"),
  lastName: z.string().trim().min(1, "יש להזין שם משפחה"),
  nationalId: z.string().trim().min(5, "תעודת זהות קצרה מדי"),
  email: z.string().trim().email("כתובת מייל לא תקינה"),
  phone: z.string().trim().optional().default(""),
});

// POST /api/employees — הקמת עובד מהירה. כתיבה: בעלים/מזכירה בלבד.
export async function POST(req: Request) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים שגויים" }, { status: 400 });
  }
  const d = parsed.data;
  try {
    const emp = await prisma.employee.create({
      data: {
        firstName: d.firstName,
        lastName: d.lastName,
        nationalId: d.nationalId,
        email: d.email,
        phone: d.phone || null,
        startDate: new Date(),
        companyId: me.companyId,
        status: "ACTIVE",
      },
      select: { id: true, firstName: true, lastName: true },
    });
    return NextResponse.json({ id: emp.id, name: `${emp.firstName} ${emp.lastName}` }, { status: 201 });
  } catch (err) {
    // התנגשות ייחודיות — ת"ז או מייל שכבר קיימים.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const field = (err.meta?.target as string[] | undefined)?.join(", ") ?? "";
      const msg = field.includes("national")
        ? "עובד עם תעודת זהות זו כבר קיים"
        : field.includes("email")
          ? "עובד עם כתובת מייל זו כבר קיים"
          : "עובד עם פרטים אלו כבר קיים";
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    return NextResponse.json({ error: "שגיאה בהקמת העובד" }, { status: 500 });
  }
}
