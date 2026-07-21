import Anthropic from "@anthropic-ai/sdk";

// לקוח Anthropic משותף. משתמש ב-ANTHROPIC_API_KEY מהסביבה.
export const anthropic = new Anthropic();

// מודל ברירת המחדל לצ'אטבוט ההתייעצות.
// Haiku 4.5 — מהיר משמעותית, ומתאים לתשובות מבוססות-אחזור (RAG).
export const CHAT_MODEL = "claude-haiku-4-5-20251001";
