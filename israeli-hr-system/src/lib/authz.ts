import { sessionUser } from "./webauthn";
import { getAdminByUsername } from "./admin";

// מחזיר את המשתמש המחובר אם הוא הבעלים (owner) ופעיל — אחרת null.
// משמש להגנה על נתיבי ניהול המשתמשים (יצירה/השבתה) — רק הבעלים מורשה.
export async function requireOwner(req: Request) {
  const username = await sessionUser(req);
  if (!username) return null;
  const me = await getAdminByUsername(username);
  return me && me.isOwner && me.active ? me : null;
}
