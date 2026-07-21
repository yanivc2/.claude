import { NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { prisma } from "@/lib/prisma";
import { rpFromRequest, REG_CHALLENGE_COOKIE, sessionUser } from "@/lib/webauthn";

// POST — אימות רישום מפתח ביומטרי ושמירתו (מחייב להיות מחובר).
export async function POST(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const body = await req.json();
  const cookie = req.headers.get("cookie") ?? "";
  const chal = cookie.match(new RegExp(`${REG_CHALLENGE_COOKIE}=([^;]+)`))?.[1];
  if (!chal) return NextResponse.json({ error: "פג תוקף. נסה/י שוב." }, { status: 400 });

  const { rpID, origin } = rpFromRequest(req);
  const verification = await verifyRegistrationResponse({
    response: body,
    expectedChallenge: decodeURIComponent(chal),
    expectedOrigin: origin,
    expectedRPID: rpID,
  }).catch(() => null);

  if (!verification?.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "הרישום נכשל" }, { status: 400 });
  }

  const cred = verification.registrationInfo.credential;
  await prisma.webauthnCredential.create({
    data: {
      username,
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString("base64url"),
      counter: cred.counter,
      transports: cred.transports ? JSON.stringify(cred.transports) : null,
    },
  });

  const res = NextResponse.json({ verified: true });
  res.cookies.set(REG_CHALLENGE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
