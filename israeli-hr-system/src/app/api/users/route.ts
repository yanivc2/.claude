import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";
import { listAdmins } from "@/lib/admin";
import { hashPassword } from "@/lib/password";

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "שם משתמש קצר מדי (לפחות 3 תווים)")
    .max(40, "שם משתמש ארוך מדי")
    .regex(/^[a-zA-Z0-9._-]+$/, "שם המשתמש יכול להכיל אותיות באנגלית, ספרות, נקודה, מקף וקו תחתון"),
  name: z.string().trim().min(1, "יש להזין שם"),
  email: z.string().trim().email("כתובת דוא״ל לא תקינה"),
  password: z.string().min(6, "הסיסמה חייבת לפחות 6 תווים"),
});

// GET /api/users — רשימת המשתמשים (בעלים בלבד).
export async function GET(req: Request) {
  const owner = await requireOwner(req);
  if (!owner) return NextResponse.json({ error: "לא מורשה" }, { status: 403 });

  const users = await listAdmins();
  return NextResponse.json(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      email: u.email,
      isOwner: u.isOwner,
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

  const created = await prisma.adminUser.create({
    data: {
      username: parsed.data.username,
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      isOwner: false,
      active: true,
    },
  });

  return NextResponse.json({ id: created.id, username: created.username }, { status: 201 });
}
