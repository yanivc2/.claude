import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";

// GET /api/task-presets — רובריקות משימה לשימוש חוזר.
export async function GET(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const presets = await prisma.taskPreset.findMany({ orderBy: { createdAt: "asc" }, take: 50 });
  return NextResponse.json(presets);
}

const schema = z.object({ title: z.string().trim().min(1).max(120) });

// POST /api/task-presets — שמירת רובריקה חדשה.
export async function POST(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });
  const p = await prisma.taskPreset.create({
    data: { title: parsed.data.title, createdBy: me.username },
  });
  return NextResponse.json({ id: p.id, title: p.title }, { status: 201 });
}
