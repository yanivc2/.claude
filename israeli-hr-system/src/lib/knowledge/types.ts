// ─────────────────────────────────────────────────────────────────────────
// טיפוסים משותפים ועזרי מקור לבסיס הידע של "יועץ לזכויות עובדים".
// כל קטע ידע מקורו במאגר "כל זכות" (kolzchut.org.il) ובחקיקת העבודה בישראל.
// ─────────────────────────────────────────────────────────────────────────

export interface KnowledgeItem {
  title: string;
  category: string;
  source: string;
  sourceUrl: string | null;
  keywords: string[];
  content: string;
}

// מקור ברירת המחדל + בונה כתובת לערך ב"כל זכות" לפי slug.
export const KZ = "כל זכות";
export const url = (slug: string) => `https://www.kolzchut.org.il/he/${slug}`;
