import Anthropic from "@anthropic-ai/sdk";

// לקוח Anthropic משותף. משתמש ב-ANTHROPIC_API_KEY מהסביבה.
export const anthropic = new Anthropic();

// מודל ברירת המחדל לצ'אטבוט ההתייעצות.
// Sonnet — חכם ומדויק יותר בשאלות מורכבות של דיני עבודה (איטי/יקר מעט יותר מ-Haiku).
export const CHAT_MODEL = "claude-sonnet-5";
