import Anthropic from "@anthropic-ai/sdk";

// לקוח Anthropic משותף. משתמש ב-ANTHROPIC_API_KEY מהסביבה.
export const anthropic = new Anthropic();

// מודל ברירת המחדל לצ'אטבוט ההתייעצות.
export const CHAT_MODEL = "claude-opus-4-8";
