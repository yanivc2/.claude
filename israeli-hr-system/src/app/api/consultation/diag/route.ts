import { NextResponse } from "next/server";
import { anthropic } from "@/lib/anthropic";
import { requireOwner } from "@/lib/authz";

export const dynamic = "force-dynamic";

// מודלים לבדיקה — מהחדש לישן. מגלה למה מפתח ה-API של האתר מורשה בפועל.
const CANDIDATES = [
  "claude-sonnet-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-1",
  "claude-haiku-4-5-20251001",
];

// GET /api/consultation/diag — אבחון זמני (בעל המערכת בלבד): בודק אילו מודלים
// זמינים למפתח ה-API של האתר, ומחזיר את השגיאה המדויקת לכל מודל שנכשל.
export async function GET(req: Request) {
  const owner = await requireOwner(req);
  if (!owner) return NextResponse.json({ error: "לא מורשה" }, { status: 403 });

  const results = [];
  for (const model of CANDIDATES) {
    try {
      await anthropic.messages.create({
        model,
        max_tokens: 4,
        messages: [{ role: "user", content: "היי" }],
      });
      results.push({ model, ok: true });
    } catch (err: unknown) {
      const e = err as { status?: number; name?: string; message?: string };
      results.push({
        model,
        ok: false,
        status: e?.status ?? null,
        type: e?.name ?? null,
        error: e?.message ?? String(err),
      });
    }
  }

  return NextResponse.json({
    activeDefault: process.env.CONSULTATION_MODEL || "claude-sonnet-4-5",
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    results,
  });
}
