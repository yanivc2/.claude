import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";
import { hashPassword } from "@/lib/password";

const patchSchema = z.object({
  active: z.boolean().optional(),
  password: z.string().min(6, "הסיסמה חייבת לפחות 6 תווים").optional(),
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

  const data: { active?: boolean; passwordHash?: string; pendingPasswordHash?: null; confirmCodeHash?: null; confirmExpiresAt?: null } = {};
  if (parsed.data.active !== undefined) data.active = parsed.data.active;
  if (parsed.data.password) {
    data.passwordHash = await hashPassword(parsed.data.password);
    // מבטל בקשת שינוי-סיסמה תלויה, אם קיימת.
    data.pendingPasswordHash = null;
    data.confirmCodeHash = null;
    data.confirmExpiresAt = null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "אין שינוי לביצוע" }, { status: 400 });
  }

  await prisma.adminUser.update({ where: { id }, data });
  return NextResponse.json({ status: "ok" });
}
