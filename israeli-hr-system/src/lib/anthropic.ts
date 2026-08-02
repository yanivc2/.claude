import Anthropic from "@anthropic-ai/sdk";

// לקוח Anthropic משותף. משתמש ב-ANTHROPIC_API_KEY מהסביבה.
export const anthropic = new Anthropic();

// מודל ברירת המחדל לצ'אטבוט ההתייעצות — Sonnet 5 (החכם ביותר; אומת שנגיש
// למפתח ה-API של האתר). ניתן לעקוף דרך משתנה הסביבה CONSULTATION_MODEL
// (למשל "claude-sonnet-4-5" אם רוצים מודל יציב/זול יותר).
export const CHAT_MODEL = process.env.CONSULTATION_MODEL || "claude-sonnet-5";

// מודל גיבוי אם הראשי נכשל (למשל אין הרשאה למודל הראשי) — Haiku 4.5, נגיש ואמין.
export const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
