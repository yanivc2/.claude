import { NextResponse } from "next/server";
import { fetchAllLegalUpdates } from "@/lib/legalFetcher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/legal-updates — משיכת עדכוני חקיקה. מיועד לריצה שבועית.
// דוגמת תזמון ב-vercel.json:
//   { "crons": [{ "path": "/api/cron/legal-updates", "schedule": "0 6 * * 1" }] }
export async function GET(req: Request) {
  // אימות הקריאה מול CRON_SECRET (Vercel Cron שולח כ-Authorization: Bearer).
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }

  const results = await fetchAllLegalUpdates();
  const inserted = results.reduce((sum, r) => sum + r.inserted, 0);

  return NextResponse.json({ ranAt: new Date().toISOString(), inserted, results });
}
