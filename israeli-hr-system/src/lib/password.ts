// גיבוב סיסמאות באמצעות PBKDF2 (Web Crypto) — ללא תלות חיצונית.
// פורמט השמירה: pbkdf2$<iterations>$<saltHex>$<hashHex>

const enc = new TextEncoder();
const ITER = 120_000;
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(enc.encode(password)), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: buf(salt), iterations: iter, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITER);
  return `pbkdf2$${ITER}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iter = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = parts[3];
  const actual = toHex(await derive(password, salt, iter));
  // השוואה בזמן קבוע.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
