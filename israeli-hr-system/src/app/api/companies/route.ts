import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

// GET /api/companies — רשימת החברות.
export async function GET() {
  try {
    const companies = await prisma.company.findMany({ orderBy: { name: "asc" } });
    return NextResponse.json(companies.map((c) => ({ id: c.id, name: c.name })));
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}

const createSchema = z.object({ name: z.string().min(1) });

// POST /api/companies — הוספת חברה.
export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "שם חברה חסר" }, { status: 400 });
  }
  try {
    const company = await prisma.company.create({ data: { name: parsed.data.name.trim() } });
    return NextResponse.json({ id: company.id, name: company.name }, { status: 201 });
  } catch {
    // כפילות שם או שגיאה אחרת.
    return NextResponse.json({ error: "החברה כבר קיימת או שאירעה שגיאה." }, { status: 400 });
  }
}
