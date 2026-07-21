import { NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { prisma } from "@/lib/prisma";
import { getAuthConfig, signSession, SESSION_COOKIE } from "@/lib/auth";
import { rpFromRequest, LOGIN_CHALLENGE_COOKIE } from "@/lib/webauthn";

// POST — אימות כניסה ביומטרית והנפקת עוגיית סשן.
export async function POST(req: Request) {
  const body = await req.json();
  const cookie = req.headers.get("cookie") ?? "";
  const chal = cookie.match(new RegExp(`${LOGIN_CHALLENGE_COOKIE}=([^;]+)`))?.[1];
  if (!chal) return NextResponse.json({ error: "פג תוקף. נסה/י שוב." }, { status: 400 });

  const cred = await prisma.webauthnCredential.findUnique({ where: { credentialId: body.id } });
  if (!cred) return NextResponse.json({ error: "מפתח לא מוכר" }, { status: 400 });

  const { rpID, origin } = rpFromRequest(req);
  const verification = await verifyAuthenticationResponse({
    response: body,
    expectedChallenge: decodeURIComponent(chal),
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: cred.credentialId,
      publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
      counter: cred.counter,
      transports: cred.transports ? JSON.parse(cred.transports) : undefined,
    },
  }).catch(() => null);

  if (!verification?.verified) {
    return NextResponse.json({ error: "האימות נכשל" }, { status: 401 });
  }

  await prisma.webauthnCredential.update({
    where: { id: cred.id },
    data: { counter: verification.authenticationInfo.newCounter },
  });

  const token = await signSession(cred.username, getAuthConfig().secret);
  const res = NextResponse.json({ verified: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  res.cookies.set(LOGIN_CHALLENGE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
