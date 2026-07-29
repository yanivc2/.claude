import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";
import { hashPassword } from "@/lib/password";

const patchSchema = z.object({
  active: z.boolean().optional(),
  password: z.string().min(6, "הסיסמה חייבת לפחות 6 תווים").optional(),
  role: z.enum(["SECRETARY", "STORE_MANAGER"]).optional(),
  companyId: z.string().nullable().optional(),
});

// PATCH /api/users/[id] — השבתה/הפעלה או איפוס סיסמה של משתמש (בעלים בלבד).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner(req);
  if (!owner) return NextResponse.json({ error: "לא מורשה" }, { status: 403 });

  const { id } = await ctx.params;
  const target = await prisma.adminUser.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ error: "המשתמש לא נמצא" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים שגויים" },
      { status: 400 },
    );
  }

  // הגנות: אין להשבית את הבעלים, ואין להשבית את עצמך.
  if (parsed.data.active === false && (target.isOwner || target.id === owner.id)) {
    return NextResponse.json({ error: "לא ניתן להשבית את חשבון הבעלים" }, { status: 400 });
  }
  // אין לשנות את רמת ההרשאה של הבעלים.
  if ((parsed.data.role !== undefined || parsed.data.companyId !== undefined) && target.isOwner) {
    return NextResponse.json({ error: "לא ניתן לשנות את הרשאת הבעלים" }, { status: 400 });
  }

  const data: {
    active?: boolean;
    passwordHash?: string;
    pendingPasswordHash?: null;
    confirmCodeHash?: null;
    confirmExpiresAt?: null;
    role?: "SECRETARY" | "STORE_MANAGER";
    companyId?: string | null;
  } = {};
  if (parsed.data.active !== undefined) data.active = parsed.data.active;
  if (parsed.data.password) {
    data.passwordHash = await hashPassword(parsed.data.password);
    // מבטל בקשת שינוי-סיסמה תלויה, אם קיימת.
    data.pendingPasswordHash = null;
    data.confirmCodeHash = null;
    data.confirmExpiresAt = null;
  }

  // עדכון רמת הרשאה/חברה. הרמה האפקטיבית לאחר העדכון נגזרת מ-role החדש
  // (אם נשלח) או מהקיים.
  const effectiveRole = parsed.data.role ?? (target.role as "SECRETARY" | "STORE_MANAGER");
  if (parsed.data.role !== undefined) data.role = parsed.data.role;
  if (parsed.data.companyId !== undefined || parsed.data.role !== undefined) {
    if (effectiveRole === "STORE_MANAGER") {
      const companyId = parsed.data.companyId ?? target.companyId;
      if (!companyId) {
        return NextResponse.json({ error: "יש לבחור חברה עבור מנהל חנות" }, { status: 400 });
      }
      const company = await prisma.company.findUnique({ where: { id: companyId } });
      if (!company) return NextResponse.json({ error: "החברה שנבחרה לא נמצאה" }, { status: 400 });
      data.companyId = companyId;
    } else {
      // מזכירה — ללא שיוך חברה (רואה הכל).
      data.companyId = null;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "אין שינוי לביצוע" }, { status: 400 });
  }

  await prisma.adminUser.update({ where: { id }, data });
  return NextResponse.json({ status: "ok" });
}
