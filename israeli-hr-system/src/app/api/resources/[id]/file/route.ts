import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sessionUser } from "@/lib/webauthn";

// GET /api/resources/[id]/file — הורדת קובץ המשאב (מפענח את ה-data URL לקובץ אמיתי).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const { id } = await ctx.params;
  const r = await prisma.resource.findUnique({ where: { id } }).catch(() => null);
  if (!r || r.kind !== "FILE" || !r.fileData) {
    return NextResponse.json({ error: "הקובץ לא נמצא" }, { status: 404 });
  }

  const m = /^data:([^;]+);base64,(.*)$/s.exec(r.fileData);
  if (!m) return NextResponse.json({ error: "קובץ לא תקין" }, { status: 422 });

  const mime = r.mimeType || m[1] || "application/octet-stream";
  const bytes = Buffer.from(m[2], "base64");
  const name = encodeURIComponent(r.fileName || "file");

  // ?download=1 → הורדה כקובץ (attachment); ברירת מחדל → תצוגה מוטמעת (inline).
  const wantDownload = new URL(req.url).searchParams.get("download") === "1";
  const disposition = wantDownload ? "attachment" : "inline";

  return new Response(bytes, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${name}`,
      "Content-Length": String(bytes.length),
    },
  });
}
