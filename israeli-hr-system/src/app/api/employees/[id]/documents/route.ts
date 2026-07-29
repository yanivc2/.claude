import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireWriter, roleOf, canAccessEmployee } from "@/lib/rbac";

const schema = z.object({
  type: z.enum(["PENSION_TRANSFER", "OTHER"]).default("PENSION_TRANSFER"),
  fileName: z.string().min(1),
  mimeType: z.string().optional(),
  data: z.string().min(1), // data URL
});

// ~6MB מחרוזת data URL (מתחת למגבלת גוף הבקשה של Vercel).
const MAX_CHARS = 6_000_000;

// POST /api/employees/[id]/documents — הוספת מסמך לתיק העובד (למשל מסמך
// העברת כספי פנסיה). בעלים/מזכירה בלבד, מוגבל לעובד בהיקף שלהם.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  if (!(await canAccessEmployee(me, id))) {
    return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });
  const d = parsed.data;
  if (d.data.length > MAX_CHARS) {
    return NextResponse.json({ error: "הקובץ גדול מדי (עד ~4MB)." }, { status: 413 });
  }

  const doc = await prisma.employeeDocument.create({
    data: {
      employeeId: id,
      type: d.type,
      fileName: d.fileName,
      fileUrl: d.data,
      mimeType: d.mimeType || null,
      uploadedByRole: roleOf(me),
    },
  });
  return NextResponse.json({ id: doc.id }, { status: 201 });
}
