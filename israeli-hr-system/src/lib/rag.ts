import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, CHAT_MODEL } from "./anthropic";
import { KNOWLEDGE_BASE } from "./knowledgeBase";

// ─────────────────────────────────────────────────────────────────────────
// שכבת RAG (Retrieval-Augmented Generation)
//
// הבוט מסתמך אך ורק על בסיס הידע המשפטי שבמסד הנתונים (KnowledgeChunk +
// LegalUpdate). כאן משתמשים באחזור מבוסס מילות מפתח פשוט; בפרודקשן מומלץ
// להחליף ל-embeddings וקטוריים (למשל pgvector) לדיוק גבוה יותר.
// ─────────────────────────────────────────────────────────────────────────

export interface RetrievedChunk {
  title: string;
  content: string;
  source: string;
  sourceUrl: string | null;
}

// נרמול עברי לאחזור עמיד יותר: איחוד אותיות סופיות (ם→מ וכו'), הסרת גרשיים/פיסוק,
// והפשטת תחילית דקדוקית יחידה (ו/ה/ב/כ/ל/מ/ש) כדי לזהות הטיות ("לפיטורים"↔"פיטורים").
const FINAL_FORMS: Record<string, string> = { "ם": "מ", "ן": "נ", "ץ": "צ", "ף": "פ", "ך": "כ" };
const PREFIXES = new Set(["ו", "ה", "ב", "כ", "ל", "מ", "ש"]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'`׳״.,;:!?()\[\]{}\/\\-]/g, " ")
    .replace(/[םןץףך]/g, (c) => FINAL_FORMS[c] ?? c);
}

// גזע גס: מסיר תחילית עברית יחידה כשנשארת מילה בעלת אורך סביר.
function stem(term: string): string {
  if (term.length > 3 && PREFIXES.has(term[0])) return term.slice(1);
  return term;
}

// ניקוד רלוונטיות לפי חפיפת מילים (מנורמלות + גזומות) בין השאלה לקטע.
function scoreChunk(
  query: string,
  chunk: { title: string; content: string; keywords: string[] },
): number {
  const terms = normalize(query)
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const haystack = normalize(`${chunk.title} ${chunk.content} ${chunk.keywords.join(" ")}`);
  const keyNorm = chunk.keywords.map((k) => normalize(k));
  let score = 0;
  for (const raw of terms) {
    const term = stem(raw);
    if (haystack.includes(raw) || haystack.includes(term)) score += 1;
    // התאמה למילת מפתח (מנורמלת/גזומה) — משקל גבוה יותר.
    if (keyNorm.some((k) => k.includes(term) || stem(k) === term)) score += 2;
  }
  return score;
}

// אחזור הקטעים הרלוונטיים ביותר מבסיס הידע (מודול הקוד — מהיר, ללא מסד).
export async function retrieveContext(query: string, limit = 6): Promise<RetrievedChunk[]> {
  const ranked = KNOWLEDGE_BASE.map((c) => ({ chunk: c, score: scoreChunk(query, c) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked.map(({ chunk }) => ({
    title: chunk.title,
    content: chunk.content,
    source: chunk.source,
    sourceUrl: chunk.sourceUrl,
  }));
}

function buildSystemPrompt(chunks: RetrievedChunk[]): string {
  const context =
    chunks.length > 0
      ? chunks
          .map(
            (c, i) =>
              `[מקור ${i + 1}] ${c.title}\nמקור: ${c.source}${
                c.sourceUrl ? ` (${c.sourceUrl})` : ""
              }\n${c.content}`,
          )
          .join("\n\n---\n\n")
      : "לא נמצא מידע רלוונטי בבסיס הידע.";

  return `אתה "יועץ לזכויות עובדים" — יועץ מומחה לדיני עבודה בישראל עבור מנהלים ועובדים.
בסיס הידע שלך מבוסס על מאגר "כל זכות" (kolzchut.org.il) ועל חקיקת העבודה בישראל.

כללי יסוד מחייבים (הפרתם = תשובה שגויה):
1. ענה אך ורק על סמך "בסיס הידע" המצורף למטה. אל תסתמך על ידע כללי או על זיכרון משלך, גם אם אתה "בטוח".
2. כל נתון מספרי (סכומים, אחוזים, ימים, תקופות) וכל אזכור של סעיף/חוק — מותר אך ורק אם הוא מופיע מילולית בבסיס הידע. אסור בהחלט להסיק, לחשב, לעגל או להשלים מספרים שאינם כתובים במפורש.
3. אם המידע הדרוש חסר או חלקי — אמור זאת במפורש ("המידע אינו מצוי בבסיס הידע שלי") והפנה ל"כל זכות" או לייעוץ משפטי מוסמך. עדיף להשיב "איני יודע" מאשר לנחש.
4. אם השאלה עמומה או חסרה פרט מהותי לתשובה (למשל ותק, סוג העסקה, שכר חודשי מול שעתי) — שאל שאלת הבהרה קצרה אחת לפני שתענה, במקום להניח.
5. אם השאלה אינה בתחום דיני העבודה בישראל — אמור זאת בנימוס ואל תענה עליה.
6. צטט בסוף כל תשובה את מספרי המקורות שעליהם התבססת (למשל: "מקורות: 1, 3").
7. ענה בעברית, בשפה ברורה, מקצועית ותמציתית. אל תציג סברות אישיות כעובדות.

בסיס הידע:
${context}`;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface RagAnswer {
  answer: string;
  citations: RetrievedChunk[];
}

// יצירת תשובת RAG לשאלה על זכויות וחוקי עבודה.
export async function answerLegalQuestion(
  question: string,
  history: ChatTurn[] = [],
): Promise<RagAnswer> {
  const chunks = await retrieveContext(question);
  const system = buildSystemPrompt(chunks);

  // temperature: 0 — תשובות עובדתיות יציבות ומדויקות, עם מינימום שונות/המצאות.
  // ללא extended thinking — לתגובה מהירה יותר.
  const response = await anthropic.messages.create({
    model: CHAT_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system,
    messages: [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: question },
    ],
  });

  const answer = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return { answer, citations: chunks };
}
