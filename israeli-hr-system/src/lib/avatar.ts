// עזרי אווטאר משותפים — ראשי תיבות וצבע רקע דטרמיניסטי לפי שם.

const AVATAR_GRADIENTS = [
  "from-blue-500 to-blue-700",
  "from-sky-500 to-cyan-700",
  "from-violet-500 to-purple-700",
  "from-amber-500 to-orange-700",
  "from-emerald-500 to-teal-700",
  "from-rose-500 to-pink-700",
];

// צבע עקבי לאותו שם (אותו רקע בכל מקום ובכל רינדור).
export function avatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

export function initials(first: string, last = ""): string {
  return ((first?.[0] ?? "") + (last?.[0] ?? "")).trim() || "עו";
}
