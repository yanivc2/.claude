import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";
import { listAdmins } from "@/lib/admin";
import { hashPassword } from "@/lib/password";

const createSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3, "שם משתמש קצר מדי (לפחות 3 תווים)")
      .max(40, "שם משתמש ארוך מדי")
      .regex(/^[a-zA-Z0-9._-]+$/, "שם המשתמש יכול להכיל אותיות באנגלית, ספרות, נקודה, מקף וקו תחתון"),
    name: z.string().trim().min(1, "יש להזין שם"),
    email: z.string().trim().email("כתובת דוא״ל לא תקינה"),
    password: z.string().min(6, "הסיסמה חייבת לפחות 6 תווים"),
    // רמת הרשאה — בעלים אינו נוצר דרך כאן (יחיד ומוגדר בזריעה).
    role: z.enum(["SECRETARY", "STORE_MANAGER"]).default("SECRETARY"),
    // חובה עבור מנהל חנות — החברה שאליה הוא משויך.
    companyId: z.string().optional().nullable(),
  })
  .refine((d) => d.role !== "STORE_MANAGER" || !!d.companyId, {
    message: "יש לבחור חברה עבור מנהל חנות",
    path: ["companyId"],
  });

// GET /api/users — רשימת המשתמשים (בעלים בלבד).
export async function GET(req: Request) {
  const owner = await requireOwner(req);
  if (!owner) return NextResponse.json({ error: "לא מורשה" }, { status: 403 });

  const users = await listAdmins();
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  return NextResponse.json(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      email: u.email,
      isOwner: u.isOwner,
      role: u.isOwner ? "OWNER" : u.role,
      companyId: u.companyId,
      companyName: u.companyId ? companyName.get(u.companyId) ?? null : null,
      active: u.active,
      createdAt: u.createdAt,
    })),
  );
}

// POST /api/users — יצירת משתמש חדש (בעלים בלבד).
export async function POST(req: Request) {
  const owner = await requireOwner(req);
  if (!owner) return NextResponse.json({ error: "לא מורשה" }, { status: 403 });

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים שגויים" },
      { status: 400 },
    );
  }

  const existing = await prisma.adminUser.findUnique({ where: { username: parsed.data.username } });
  if (existing) {
    return NextResponse.json({ error: "שם המשתמש כבר תפוס" }, { status: 409 });
  }

  const isManager = parsed.data.role === "STORE_MANAGER";
  const companyId = isManager ? parsed.data.companyId ?? null : null;
  if (isManager && companyId) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return NextResponse.json({ error: "החברה שנבחרה לא נמצאה" }, { status: 400 });
  }

  const created = await prisma.adminUser.create({
    data: {
      username: parsed.data.username,
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      isOwner: false,
      role: parsed.data.role,
      companyId,
      active: true,
    },
  });

  return NextResponse.json({ id: created.id, username: created.username }, { status: 201 });
}
