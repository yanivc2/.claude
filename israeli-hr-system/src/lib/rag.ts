import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, CHAT_MODEL } from "./anthropic";
import { KNOWLEDGE_BASE, type KnowledgeItem } from "./knowledge";

// ─────────────────────────────────────────────────────────────────────────
// מנוע היועץ לזכויות עובדים.
//
// גישה: "כל המאגר בזיכרון" — במקום לשלוף כמה קטעים לפי מילות מפתח (שעלול
// להחמיץ נושא רלוונטי), כל בסיס הידע מוזרק לפרומפט בכל שאלה. כך הבוט תמיד
// רואה את כל הנושאים ואין "החמצת אחזור". בלוק הידע יציב בין קריאות ולכן
// נשמר ב-prompt cache (משלמים על עיבודו פעם אחת — מהיר וזול בקריאות חוזרות).
// ─────────────────────────────────────────────────────────────────────────

export interface RetrievedChunk {
  title: string;
  content: string;
  source: string;
  sourceUrl: string | null;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface RagAnswer {
  answer: string;
  citations: RetrievedChunk[];
}

// בלוק הידע המלא — נבנה פעם אחת בטעינת המודול. כל מקור ממוספר לצורך ציטוט.
const KNOWLEDGE_TEXT = KNOWLEDGE_BASE.map(
  (c, i) =>
    `[מקור ${i + 1}] ${c.title} · ${c.category}\n` +
    `מקור: ${c.source}${c.sourceUrl ? ` — ${c.sourceUrl}` : ""}\n` +
    c.content,
).join("\n\n");

const INSTRUCTIONS = `אתה "יועץ לזכויות עובדים" — יועץ מומחה לדיני עבודה בישראל עבור מנהלים ועובדים.
בסיס הידע שלך מבוסס על מאגר "כל זכות" (kolzchut.org.il) ועל חקיקת העבודה בישראל, ומצורף לך במלואו.

כללי יסוד מחייבים (הפרתם = תשובה שגויה):
1. ענה אך ורק על סמך "בסיס הידע" המצורף. אל תסתמך על ידע כללי או על זיכרון משלך, גם אם אתה "בטוח".
2. כל נתון מספרי (סכומים, אחוזים, ימים, תקופות) וכל אזכור של סעיף/חוק — מותר אך ורק אם הוא מופיע מילולית בבסיס הידע. אסור להסיק, לחשב, לעגל או להשלים מספרים שאינם כתובים במפורש.
3. אם המידע הדרוש חסר או חלקי — אמור זאת במפורש ("המידע אינו מצוי בבסיס הידע שלי") והפנה ל"כל זכות" או לייעוץ משפטי מוסמך. עדיף להשיב "איני יודע" מאשר לנחש.
4. אם השאלה עמומה או חסרה פרט מהותי (ותק, סוג העסקה, שכר חודשי מול שעתי) — שאל שאלת הבהרה קצרה אחת לפני שתענה.
5. אם השאלה אינה בתחום דיני העבודה בישראל — אמור זאת בנימוס ואל תענה עליה.
6. ענה בעברית, בשפה ברורה, מקצועית ותמציתית. אל תציג סברות אישיות כעובדות.
7. אל תוסיף בגוף התשובה רשימת מקורות. במקום זאת, בשורה האחרונה של התשובה כתוב בדיוק את מספרי המקורות שעליהם התבססת בפורמט: "SOURCES: 3, 17" (מספרי [מקור N] מבסיס הידע). אם לא התבססת על אף מקור — כתוב "SOURCES: none".`;

const KZ_ITEM_TO_CHUNK = (item: KnowledgeItem): RetrievedChunk => ({
  title: item.title,
  content: item.content,
  source: item.source,
  sourceUrl: item.sourceUrl,
});

// מפריד את שורת ה-SOURCES מגוף התשובה וממפה את מספרי המקורות לקטעי הידע.
function parseCitations(raw: string): RagAnswer {
  const lines = raw.split("\n");
  // מאתרים את שורת ה-SOURCES האחרונה (בדרך כלל בסוף).
  let sourcesLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*SOURCES\s*:/i.test(lines[i])) {
      sourcesLineIdx = i;
      break;
    }
  }
  if (sourcesLineIdx === -1) {
    return { answer: raw.trim(), citations: [] };
  }
  const nums = (lines[sourcesLineIdx].match(/\d+/g) ?? []).map(Number);
  const seen = new Set<number>();
  const citations = nums
    .filter((n) => n >= 1 && n <= KNOWLEDGE_BASE.length && !seen.has(n) && seen.add(n))
    .map((n) => KZ_ITEM_TO_CHUNK(KNOWLEDGE_BASE[n - 1]));
  lines.splice(sourcesLineIdx, 1);
  return { answer: lines.join("\n").trim(), citations };
}

// יצירת תשובה לשאלה על זכויות וחוקי עבודה — כל המאגר בהקשר, temperature 0.
export async function answerLegalQuestion(
  question: string,
  history: ChatTurn[] = [],
): Promise<RagAnswer> {
  const response = await anthropic.messages.create({
    model: CHAT_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: [
      { type: "text", text: INSTRUCTIONS },
      {
        type: "text",
        text: `בסיס הידע המלא (${KNOWLEDGE_BASE.length} מקורות):\n\n${KNOWLEDGE_TEXT}`,
        // שמירת בלוק הידע במטמון — יציב בין קריאות, מוזיל ומאיץ משמעותית.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: question },
    ],
  });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return parseCitations(raw);
}
