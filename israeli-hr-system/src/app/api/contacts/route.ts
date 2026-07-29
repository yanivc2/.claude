import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireWriter } from "@/lib/rbac";

// GET /api/contacts — רשימת אנשי הקשר. לכל מנהל מחובר (לצורך בחירת נמען לשליחה).
export async function GET(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const contacts = await prisma.contact.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] });
  return NextResponse.json(contacts);
}

const schema = z.object({
  type: z.enum(["GENERAL", "PENSION_AGENT"]).default("GENERAL"),
  name: z.string().trim().min(1, "יש להזין שם"),
  agency: z.string().trim().optional(),
  email: z.string().trim().email("כתובת דוא״ל לא תקינה").optional().or(z.literal("")),
  phone: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  companyId: z.string().optional().nullable(),
});

// POST /api/contacts — הוספת איש קשר. בעלים/מזכירה בלבד.
export async function POST(req: Request) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים שגויים" },
      { status: 400 },
    );
  }
  const d = parsed.data;
  const created = await prisma.contact.create({
    data: {
      type: d.type,
      name: d.name,
      agency: d.agency || null,
      email: d.email || null,
      phone: d.phone || null,
      notes: d.notes || null,
      companyId: d.companyId || null,
    },
  });
  return NextResponse.json({ id: created.id }, { status: 201 });
}
