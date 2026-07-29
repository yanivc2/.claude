import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, roleOf } from "@/lib/rbac";
import { notifyOwner } from "@/lib/notifications";

const createSchema = z
  .object({
    title: z.string().trim().min(1, "יש להזין כותרת").max(200),
    description: z.string().trim().max(2000).optional(),
    kind: z.enum(["FILE", "LINK"]),
    url: z.string().trim().url("כתובת הקישור אינה תקינה").optional(),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    fileData: z.string().optional(), // data URL
    folderId: z.string().optional(), // שיוך לתיקייה
  })
  .refine((d) => (d.kind === "LINK" ? !!d.url : !!d.fileData), {
    message: "יש לצרף קובץ או להזין קישור",
  });

// כ-6MB מחרוזת data URL (מתחת למגבלת גוף הבקשה של Vercel).
const MAX_FILE_CHARS = 6_000_000;

// GET /api/resources — רשימת המשאבים (ללא תוכן הקובץ הכבד).
//   בעלים  — הכל, כולל פריטים הממתינים לאישור (PENDING) לצורך אישור.
//   אחרים  — מאושרים בלבד (מנהל חנות רואה גם את הפריטים שהוא עצמו העלה,
//            כדי לעקוב אחר סטטוס האישור).
export async function GET(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const role = roleOf(me);
  const where =
    role === "OWNER"
      ? {}
      : {
          OR: [{ status: "APPROVED" as const }, { createdBy: me.username }],
        };

  const items = await prisma.resource
    .findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        kind: true,
        description: true,
        url: true,
        fileName: true,
        mimeType: true,
        folderId: true,
        status: true,
        uploadedByRole: true,
        createdAt: true,
      },
    })
    .catch(() => []);

  return NextResponse.json(items);
}

// POST /api/resources — הוספת מסמך/קישור. לכל משתמש מחובר.
export async function POST(req: Request) {
  // כל מנהל מחובר רשאי להעלות. בעלים/מזכירה — מאושר אוטומטית; מנהל חנות —
  // נכנס כ-PENDING וממתין לאישור הבעלים (עם פוש).
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים שגויים" },
      { status: 400 },
    );
  }
  const d = parsed.data;

  if (d.kind === "FILE" && d.fileData && d.fileData.length > MAX_FILE_CHARS) {
    return NextResponse.json({ error: "הקובץ גדול מדי (עד ~4MB)." }, { status: 413 });
  }

  const role = roleOf(me);
  const pending = role === "STORE_MANAGER";

  const created = await prisma.resource.create({
    data: {
      title: d.title,
      kind: d.kind,
      description: d.description || null,
      url: d.kind === "LINK" ? d.url ?? null : null,
      fileName: d.kind === "FILE" ? d.fileName ?? null : null,
      mimeType: d.kind === "FILE" ? d.mimeType ?? null : null,
      fileData: d.kind === "FILE" ? d.fileData ?? null : null,
      folderId: d.folderId || null,
      createdBy: me.username,
      uploadedByRole: role,
      status: pending ? "PENDING" : "APPROVED",
      companyId: me.companyId,
    },
  });

  if (pending) {
    await notifyOwner({
      type: "RESOURCE_PENDING",
      title: "מסמך/נוהל ממתין לאישור",
      body: `${me.name} העלה/תה "${d.title}" הממתין לאישורך.`,
      link: "/resources",
      actorName: me.name,
      companyId: me.companyId,
    });
  }

  return NextResponse.json({ id: created.id, status: pending ? "PENDING" : "APPROVED" }, { status: 201 });
}
