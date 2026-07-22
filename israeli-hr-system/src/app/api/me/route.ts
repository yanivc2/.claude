import { NextResponse } from "next/server";
import { sessionUser } from "@/lib/webauthn";
import { getAdminByUsername } from "@/lib/admin";

// GET /api/me — פרטי המשתמש המחובר (לתצוגה בסרגל הצד).
export async function GET(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const me = await getAdminByUsername(username);
  if (!me) return NextResponse.json({ error: "לא נמצא" }, { status: 404 });

  return NextResponse.json({ name: me.name, username: me.username, isOwner: me.isOwner });
}
