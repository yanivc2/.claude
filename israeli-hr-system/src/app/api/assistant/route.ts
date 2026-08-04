import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/rbac";
import { runAssistant } from "@/lib/assistant";

const schema = z.object({
  question: z.string().trim().min(1, "יש להזין שאלה"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional()
    .default([]),
});

// POST /api/assistant — עוזר המערכת (קריאה-בלבד) למנהלים. מחזיר תשובת טקסט.
export async function POST(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים שגויים" }, { status: 400 });
  }

  try {
    const answer = await runAssistant(me, parsed.data.question, parsed.data.history);
    return NextResponse.json({ answer });
  } catch (err) {
    console.error("assistant error", err);
    return NextResponse.json({ error: "אירעה שגיאה בקבלת התשובה. נסה/י שוב." }, { status: 500 });
  }
}
