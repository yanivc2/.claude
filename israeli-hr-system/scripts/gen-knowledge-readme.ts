// מחולל README לתיקיית בסיס הידע — יוצר אינדקס רפרנס לפי קטגוריה ומילות מפתח.
// הרצה: npx tsx scripts/gen-knowledge-readme.ts
import { writeFileSync } from "node:fs";
import { KNOWLEDGE_BASE, CATEGORIES } from "../src/lib/knowledge/index";

const lines: string[] = [];
lines.push("# בסיס הידע — יועץ לזכויות עובדים");
lines.push("");
lines.push(
  "אינדקס רפרנס לנושאי דיני העבודה שבבסיס הידע, מקורם במאגר [כל זכות](https://www.kolzchut.org.il). " +
    "מאורגן לפי קטגוריה; לכל נושא כותרת ומילות מפתח לגישה מהירה. **קובץ זה נוצר אוטומטית** " +
    "(`scripts/gen-knowledge-readme.ts`) — אין לערוך ידנית.",
);
lines.push("");
lines.push(`**סה\"כ נושאים:** ${KNOWLEDGE_BASE.length} · **קטגוריות:** ${CATEGORIES.length}`);
lines.push("");
lines.push("## מבנה התיקייה");
lines.push("");
lines.push("- `types.ts` — טיפוס `KnowledgeItem` ועזרי מקור.");
lines.push("- `core.ts` — נושאי היסוד.");
lines.push("- `expanded.ts` — נושאים שנוספו במחקר על כל זכות.");
lines.push("- `index.ts` — מאחד הכול ל-`KNOWLEDGE_BASE`, בונה `KEYWORD_INDEX` ומספק `findTopics()` / `findByTitle()`.");
lines.push("");

for (const cat of CATEGORIES) {
  const items = KNOWLEDGE_BASE.filter((k) => k.category === cat);
  lines.push(`## ${cat} (${items.length})`);
  lines.push("");
  lines.push("| נושא | מילות מפתח |");
  lines.push("| --- | --- |");
  for (const it of items) {
    lines.push(`| ${it.title} | ${it.keywords.join(" · ")} |`);
  }
  lines.push("");
}

writeFileSync(new URL("../src/lib/knowledge/README.md", import.meta.url), lines.join("\n"), "utf8");
console.log(`README נוצר: ${KNOWLEDGE_BASE.length} נושאים ב-${CATEGORIES.length} קטגוריות.`);
