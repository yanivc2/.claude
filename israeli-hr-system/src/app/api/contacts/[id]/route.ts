import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireWriter } from "@/lib/rbac";

const schema = z.object({
  type: z.enum(["GENERAL", "PENSION_AGENT"]).optional(),
  name: z.string().trim().min(1).optional(),
  agency: z.string().trim().nullable().optional(),
  email: z.string().trim().email("כתובת דוא״ל לא תקינה").nullable().optional().or(z.literal("")),
  phone: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  companyId: z.string().nullable().optional(),
});

// PATCH /api/contacts/[id] — עדכון איש קשר. בעלים/מזכירה בלבד.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים שגויים" },
      { status: 400 },
    );
  }
  const d = parsed.data;
  await prisma.contact
    .update({
      where: { id },
      data: {
        ...(d.type !== undefined ? { type: d.type } : {}),
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.agency !== undefined ? { agency: d.agency || null } : {}),
        ...(d.email !== undefined ? { email: d.email || null } : {}),
        ...(d.phone !== undefined ? { phone: d.phone || null } : {}),
        ...(d.notes !== undefined ? { notes: d.notes || null } : {}),
        ...(d.companyId !== undefined ? { companyId: d.companyId || null } : {}),
      },
    })
    .catch(() => null);
  return NextResponse.json({ status: "ok" });
}

// DELETE /api/contacts/[id] — מחיקת איש קשר. בעלים/מזכירה בלבד.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await ctx.params;
  await prisma.contact.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ status: "ok" });
}
