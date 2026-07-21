// ─────────────────────────────────────────────────────────────────────────
// ליבת האימות: חתימה/אימות של עוגיית סשן (HMAC-SHA256 דרך Web Crypto),
// והגדרות הכניסה (שם משתמש/סיסמה/סוד) ממשתני הסביבה. הקובץ טהור (ללא תלות
// ב-Node) כדי שיוכל לרוץ גם ב-middleware (edge) וגם ב-API routes.
// ─────────────────────────────────────────────────────────────────────────

export const SESSION_COOKIE = "hr_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // שבוע

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// הגדרות הכניסה. מומלץ להגדיר את שלושתם כמשתני סביבה ב-Vercel.
// ברירות מחדל קיימות כדי שהמערכת לא תינעל, אך יש להחליפן.
export function getAuthConfig() {
  return {
    // ברירות המחדל משמשות רק ל"זריעת" המנהל הראשוני במסד (bootstrap).
    username: process.env.AUTH_USERNAME || "yanivc2",
    name: process.env.AUTH_NAME || "יניב כהן",
    email: process.env.AUTH_EMAIL || "yanivc2@gmail.com",
    password: process.env.AUTH_PASSWORD || "admin",
    secret: process.env.SESSION_SECRET || "change-me-please-set-SESSION_SECRET",
    // מזהיר בעיקר על היעדר SESSION_SECRET (הסיסמה כבר במסד וניתנת לשינוי באפליקציה).
    usingDefaults: !process.env.SESSION_SECRET,
  };
}

// השוואה בזמן קבוע (מפחית דליפת מידע דרך תזמון).
export function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// עזר קטן לעקיפת אי-התאמת טיפוסים בין Uint8Array ל-BufferSource ב-TS החדש.
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    buf(enc.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// חותם טוקן סשן: base64url(payload).base64url(hmac)
export async function signSession(username: string, secret: string): Promise<string> {
  const payload = JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS });
  const payloadB64 = b64urlEncode(enc.encode(payload));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf(enc.encode(payloadB64))));
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

// מאמת טוקן סשן ומחזיר את שם המשתמש אם תקין ולא פג.
export async function verifySession(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      buf(b64urlDecode(sigB64)),
      buf(enc.encode(payloadB64)),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as {
      u: string;
      exp: number;
    };
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload.u;
  } catch {
    return null;
  }
}
