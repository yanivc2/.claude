import { NextResponse } from "next/server";
import { z } from "zod";
import { answerLegalQuestion } from "@/lib/rag";

const schema = z.object({
  question: z.string().min(1),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional()
    .default([]),
});

// POST /api/consultation — שאלת RAG על זכויות וחוקי עבודה.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "שאלה לא תקינה" }, { status: 400 });
  }

  try {
    const { answer, citations } = await answerLegalQuestion(
      parsed.data.question,
      parsed.data.history,
    );
    return NextResponse.json({ answer, citations });
  } catch (err) {
    console.error("consultation error", err);
    return NextResponse.json(
      { error: "אירעה שגיאה בהפקת התשובה. ודא שמפתח ה-API מוגדר." },
      { status: 500 },
    );
  }
}
