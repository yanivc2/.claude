import { NextResponse } from "next/server";
import {
  onboardingSchema,
  createEmployeeFromOnboarding,
  onboardingErrorMessage,
} from "@/lib/onboarding";

// POST /api/onboarding — קליטת עובד ידנית ע"י מנהל HR.
export async function POST(req: Request) {
  const parsed = onboardingSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "נתונים שגויים", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const id = await createEmployeeFromOnboarding(parsed.data);
    return NextResponse.json({ id, status: "ok" }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: onboardingErrorMessage(err) }, { status: 500 });
  }
}
