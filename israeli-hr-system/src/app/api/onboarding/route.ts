import { NextResponse } from "next/server";
import {
  onboardingSchema,
  createEmployeeFromOnboarding,
  onboardingErrorMessage,
} from "@/lib/onboarding";
import { requireWriter, roleOf } from "@/lib/rbac";

// POST /api/onboarding — קליטת עובד ידנית. כתיבה: בעלים/מזכירה בלבד.
export async function POST(req: Request) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const parsed = onboardingSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "נתונים שגויים", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const id = await createEmployeeFromOnboarding(parsed.data, roleOf(me));
    return NextResponse.json({ id, status: "ok" }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: onboardingErrorMessage(err) }, { status: 500 });
  }
}
