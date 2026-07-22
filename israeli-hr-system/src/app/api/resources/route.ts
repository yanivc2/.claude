import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sessionUser } from "@/lib/webauthn";

const createSchema = z
  .object({
    title: z.string().trim().min(1, "יש להזין כותרת").max(200),
    description: z.string().trim().max(2000).optional(),
    kind: z.enum(["FILE", "LINK"]),
    url: z.string().trim().url("כתובת הקישור אינה תקינה").optional(),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    fileData: z.string().optional(), // data URL
  })
  .refine((d) => (d.kind === "LINK" ? !!d.url : !!d.fileData), {
    message: "יש לצרף קובץ או להזין קישור",
  });

// כ-6MB מחרוזת data URL (מתחת למגבלת גוף הבקשה של Vercel).
const MAX_FILE_CHARS = 6_000_000;

// GET /api/resources — רשימת המשאבים (ללא תוכן הקובץ הכבד). לכל משתמש מחובר.
export async function GET(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const items = await prisma.resource
    .findMany({
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
    })
    .catch(() => []);

  return NextResponse.json(items);
}

// POST /api/resources — הוספת מסמך/קישור. לכל משתמש מחובר.
export async function POST(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

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

  const created = await prisma.resource.create({
    data: {
      title: d.title,
      kind: d.kind,
      description: d.description || null,
      url: d.kind === "LINK" ? d.url ?? null : null,
      fileName: d.kind === "FILE" ? d.fileName ?? null : null,
      mimeType: d.kind === "FILE" ? d.mimeType ?? null : null,
      fileData: d.kind === "FILE" ? d.fileData ?? null : null,
      createdBy: username,
    },
  });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
