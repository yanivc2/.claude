import { type KnowledgeItem } from "./types";
import { CORE_TOPICS } from "./core";
import { EXPANDED_TOPICS } from "./expanded";

export type { KnowledgeItem } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// בסיס הידע המלא של "יועץ לזכויות עובדים" = נושאי הליבה + נושאים שנוספו במחקר
// על "כל זכות". קובץ זה גם בונה אינדקס מילות מפתח לגישה מהירה לנושא לפי
// כותרת או מילה מהכותרת/ממילות המפתח.
// ─────────────────────────────────────────────────────────────────────────

export const KNOWLEDGE_BASE: KnowledgeItem[] = [...CORE_TOPICS, ...EXPANDED_TOPICS];

// רשימת הקטגוריות הקיימות (לפי סדר הופעה ראשונה).
export const CATEGORIES: string[] = [...new Set(KNOWLEDGE_BASE.map((k) => k.category))];

// נרמול עברי בסיסי לצורך אינדוקס וחיפוש (איחוד אותיות סופיות + הסרת פיסוק).
const FINAL: Record<string, string> = { "ם": "מ", "ן": "נ", "ץ": "צ", "ף": "פ", "ך": "כ" };
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'`׳״.,;:!?()\[\]{}\/\\-]/g, " ")
    .replace(/[םןץףך]/g, (c) => FINAL[c] ?? c)
    .trim();
}

// אינדקס: מילה מנורמלת → כל הנושאים שהמילה מופיעה בכותרתם או במילות המפתח שלהם.
export const KEYWORD_INDEX: Map<string, KnowledgeItem[]> = (() => {
  const map = new Map<string, KnowledgeItem[]>();
  const add = (word: string, item: KnowledgeItem) => {
    const key = norm(word);
    if (key.length < 2) return;
    const arr = map.get(key);
    if (arr) {
      if (!arr.includes(item)) arr.push(item);
    } else {
      map.set(key, [item]);
    }
  };
  for (const item of KNOWLEDGE_BASE) {
    item.title.split(/\s+/).forEach((w) => add(w, item));
    item.keywords.forEach((kw) => {
      add(kw, item); // ביטוי המפתח המלא
      kw.split(/\s+/).forEach((w) => add(w, item)); // וכל מילה בו
    });
  }
  return map;
})();

// גישה לנושא לפי כותרת מדויקת.
export function findByTitle(title: string): KnowledgeItem | undefined {
  const t = norm(title);
  return KNOWLEDGE_BASE.find((k) => norm(k.title) === t);
}

// חיפוש נושאים לפי מילה מהכותרת או ממילות המפתח (מדורגים לפי מספר ההתאמות).
export function findTopics(query: string): KnowledgeItem[] {
  const terms = norm(query).split(/\s+/).filter((t) => t.length > 1);
  const hits = new Map<KnowledgeItem, number>();
  for (const term of terms) {
    for (const [key, items] of KEYWORD_INDEX) {
      if (key === term || key.includes(term) || term.includes(key)) {
        for (const item of items) hits.set(item, (hits.get(item) ?? 0) + 1);
      }
    }
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([item]) => item);
}
