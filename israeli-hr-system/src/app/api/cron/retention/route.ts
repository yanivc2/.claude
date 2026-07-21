import { NextResponse } from "next/server";
import { processDueSurveys } from "@/lib/retention";

export const dynamic = "force-dynamic";

// GET /api/cron/retention — שליחת סקרי שביעות רצון שהגיע מועדם וזימון פגישות
// חתך למנהל. מיועד לריצה יומית.
//   { "crons": [{ "path": "/api/cron/retention", "schedule": "0 7 * * *" }] }
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }

  const processed = await processDueSurveys();
  return NextResponse.json({ ranAt: new Date().toISOString(), sent: processed.length, processed });
}
