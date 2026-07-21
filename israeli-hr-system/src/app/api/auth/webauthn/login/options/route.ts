import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { prisma } from "@/lib/prisma";
import { getAdmin } from "@/lib/admin";
import { rpFromRequest, LOGIN_CHALLENGE_COOKIE } from "@/lib/webauthn";

// POST — יצירת אתגר לכניסה ביומטרית.
export async function POST(req: Request) {
  const admin = await getAdmin();
  const username = admin?.username ?? "";
  const { rpID } = rpFromRequest(req);
  const creds = username ? await prisma.webauthnCredential.findMany({ where: { username } }) : [];
  if (creds.length === 0) {
    return NextResponse.json({ error: "לא נרשמו מפתחות ביומטריים." }, { status: 400 });
  }

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    userVerification: "preferred",
  });

  const res = NextResponse.json(options);
  res.cookies.set(LOGIN_CHALLENGE_COOKIE, options.challenge, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 300,
  });
  return res;
}
