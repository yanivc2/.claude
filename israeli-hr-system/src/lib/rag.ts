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

// ניקוד רלוונטיות פשוט לפי חפיפת מילים בין השאלה לקטע.
function scoreChunk(
  query: string,
  chunk: { title: string; content: string; keywords: string[] },
): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const haystack = `${chunk.title} ${chunk.content} ${chunk.keywords.join(" ")}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
    if (chunk.keywords.some((k) => k.toLowerCase().includes(term))) score += 2;
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

כללי יסוד מחייבים:
1. ענה אך ורק על סמך "בסיס הידע" המצורף למטה. אל תסתמך על ידע כללי שלך.
2. אם המידע הדרוש אינו מופיע בבסיס הידע, אמור זאת במפורש והמלץ לפנות ל"כל זכות" או לייעוץ משפטי מוסמך. אל תמציא עובדות, סעיפי חוק או מספרים.
3. צטט את המקורות שעליהם התבססת בסוף כל תשובה (לפי מספר המקור).
4. ענה בעברית, בשפה ברורה, מקצועית ותמציתית.

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

  // ללא extended thinking — לתגובה מהירה יותר.
  const response = await anthropic.messages.create({
    model: CHAT_MODEL,
    max_tokens: 1024,
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
