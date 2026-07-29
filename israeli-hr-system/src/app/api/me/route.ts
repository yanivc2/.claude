import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminFromRequest, roleOf } from "@/lib/rbac";

// GET /api/me — פרטי המשתמש המחובר (לתצוגה ולגזירת הרשאות בצד הלקוח).
export async function GET(req: Request) {
  const me = await adminFromRequest(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const company = me.companyId
    ? await prisma.company.findUnique({ where: { id: me.companyId }, select: { name: true } })
    : null;

  return NextResponse.json({
    name: me.name,
    username: me.username,
    isOwner: me.isOwner,
    role: roleOf(me),
    companyId: me.companyId,
    companyName: company?.name ?? null,
  });
}
