// מוסיף סבב נושאים חדש ל-expanded.ts מתוך scripts/rounds567.json.
// שימוש: node scripts/append-round.mjs <מספר-סבב>
// מייצר ליטרלים תקינים של TypeScript (escaping דרך JSON.stringify) ומכניס
// אותם לפני סוגר המערך הסופי, יחד עם הערת-סבב.
import { readFileSync, writeFileSync } from "node:fs";

const round = process.argv[2];
if (!round) {
  console.error("שימוש: node scripts/append-round.mjs <מספר-סבב>");
  process.exit(1);
}

const dataPath = new URL("./rounds567.json", import.meta.url);
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const bucket = data[round];
if (!bucket) {
  console.error(`אין נתונים לסבב ${round}`);
  process.exit(1);
}

const s = (v) => JSON.stringify(v);
const itemToTs = (it) =>
  `  {\n` +
  `    title: ${s(it.title)},\n` +
  `    category: ${s(it.category)},\n` +
  `    source: KZ,\n` +
  `    sourceUrl: url(${s(it.slug)}),\n` +
  `    keywords: [${it.keywords.map(s).join(", ")}],\n` +
  `    content:\n` +
  `      ${s(it.content)},\n` +
  `  },`;

const block =
  `\n  // ───────── ${bucket.comment} ─────────\n` +
  bucket.items.map(itemToTs).join("\n") +
  "\n";

const filePath = new URL("../src/lib/knowledge/expanded.ts", import.meta.url);
let src = readFileSync(filePath, "utf8");

// מאתרים את סוגר המערך הסופי (השורה האחרונה שהיא "];").
const idx = src.lastIndexOf("\n];");
if (idx === -1) {
  console.error("לא נמצא סוגר מערך ']' בקובץ expanded.ts");
  process.exit(1);
}

src = src.slice(0, idx) + "\n" + block + src.slice(idx + 1);
writeFileSync(filePath, src, "utf8");
console.log(`סבב ${round}: נוספו ${bucket.items.length} נושאים ל-expanded.ts`);
