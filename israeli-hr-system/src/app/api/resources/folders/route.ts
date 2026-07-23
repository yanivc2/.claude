import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sessionUser } from "@/lib/webauthn";

const createSchema = z.object({
  name: z.string().trim().min(1, "יש להזין שם לתיקייה").max(120),
});

// GET /api/resources/folders — רשימת התיקיות עם מספר הפריטים בכל אחת.
export async function GET(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const folders = await prisma.resourceFolder
    .findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, createdAt: true, _count: { select: { resources: true } } },
    })
    .catch(() => []);

  return NextResponse.json(
    folders.map((f) => ({ id: f.id, name: f.name, count: f._count.resources, createdAt: f.createdAt })),
  );
}

// POST /api/resources/folders — יצירת תיקייה חדשה.
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

  const folder = await prisma.resourceFolder.create({
    data: { name: parsed.data.name, createdBy: username },
  });
  return NextResponse.json({ id: folder.id, name: folder.name }, { status: 201 });
}
