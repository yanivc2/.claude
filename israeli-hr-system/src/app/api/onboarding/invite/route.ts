import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

// בונה את כתובת הבסיס הציבורית: מעדיף משתנה סביבה מפורש, אחרת גוזר מהבקשה.
function baseUrl(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const origin = req.headers.get("origin");
  if (origin) return origin;
  return new URL(req.url).origin;
}

const createSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  contract: z
    .object({ fileName: z.string(), mimeType: z.string(), data: z.string() })
    .nullable()
    .optional(),
});

// POST /api/onboarding/invite — יצירת הזמנת קליטה חדשה והחזרת קישור להעתקה.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });
  }

  const token = randomBytes(24).toString("base64url");

  try {
    const invite = await prisma.onboardingInvite.create({
      data: {
        token,
        firstName: parsed.data.firstName || null,
        lastName: parsed.data.lastName || null,
        email: parsed.data.email || null,
        contractFileName: parsed.data.contract?.fileName || null,
        contractFileData: parsed.data.contract?.data || null,
        contractMimeType: parsed.data.contract?.mimeType || null,
      },
    });

    const url = `${baseUrl(req)}/onboard/${invite.token}`;
    return NextResponse.json({ id: invite.id, token: invite.token, url }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "שגיאה ביצירת קישור הקליטה." }, { status: 500 });
  }
}

// GET /api/onboarding/invite — רשימת הזמנות קליטה (לתצוגה אצל HR).
// הקישור עצמו נבנה בצד הלקוח מכתובת הדפדפן, לכן לא מחזירים url כאן.
// לא שולפים את תוכן ההסכם (data URL כבד) — רק אינדיקציה אם צורף.
export async function GET() {
  try {
    const invites = await prisma.onboardingInvite.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        token: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        createdAt: true,
        completedAt: true,
        contractFileName: true,
        employee: { select: { firstName: true, lastName: true } },
      },
    });

    return NextResponse.json(
      invites.map((i) => ({
        id: i.id,
        token: i.token,
        firstName: i.firstName,
        lastName: i.lastName,
        email: i.email,
        status: i.status,
        createdAt: i.createdAt,
        completedAt: i.completedAt,
        employeeName: i.employee ? `${i.employee.firstName} ${i.employee.lastName}` : null,
        hasContract: !!i.contractFileName,
      })),
    );
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
