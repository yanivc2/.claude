import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { prisma } from "@/lib/prisma";
import { rpFromRequest, REG_CHALLENGE_COOKIE, sessionUser } from "@/lib/webauthn";

// POST — יצירת אתגר לרישום מפתח ביומטרי (מחייב להיות מחובר).
export async function POST(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const { rpID, rpName } = rpFromRequest(req);
  const existing = await prisma.webauthnCredential.findMany({ where: { username } });

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    userID: new TextEncoder().encode(username),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });

  const res = NextResponse.json(options);
  res.cookies.set(REG_CHALLENGE_COOKIE, options.challenge, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 300,
  });
  return res;
}
