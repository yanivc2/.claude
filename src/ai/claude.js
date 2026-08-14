// Claude provider for invoice extraction (stage 5 — צילום חשבוניות).
//
// One invoice = one API call: all photographed pages are sent together as image/document
// blocks with a cached Hebrew system prompt and a JSON schema (structured outputs), so the
// model can only answer in the exact shape `validateExtraction()` consumes.
// Nothing here talks to the DB or throws on bad content — the service layer validates,
// flags and persists; a human approves before an invoice is created.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/** Lazily-built singleton client (constructing it requires the API key). */
let client = null;

/**
 * The shared Anthropic client. Built on first use so the app boots (and the test suite runs)
 * without an API key; only the scan flow needs one.
 * @returns {Anthropic}
 */
export function getClaudeClient() {
  if (!client) client = new Anthropic({ apiKey: config.ai.anthropicApiKey });
  return client;
}

/** Confidence levels the model reports per field / per line. */
const CONFIDENCE = {
  type: 'string',
  enum: ['high', 'medium', 'low'],
  description: 'רמת ודאות: high כשהערך נקרא בבירור, low כשהוא מטושטש/מנוחש',
};

/**
 * Structured-outputs schema for the extraction. Legal-schema rules (enforced by the API):
 * `additionalProperties: false` on every object, a FULL `required` array (every key — optional
 * values are expressed as nullable types), nullables as `["string","null"]` / `["number","null"]`,
 * and no minLength/minimum/pattern constraints. The `description` strings are read by the model,
 * so they carry the field-level extraction rules.
 */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier_name: {
      type: 'string',
      description: 'שם הספק כפי שמודפס בראש המסמך (כולל בע"מ אם מופיע). "" אם לא ניתן לקרוא',
    },
    supplier_tax_id: {
      type: 'string',
      description: 'ח.פ. / ע.מ. של הספק — ספרות בלבד, בדרך כלל 9 ספרות. "" אם לא מופיע',
    },
    supplier_phone: {
      type: 'string',
      description:
        'טלפון הספק כפי שמודפס בראש המסמך (לא טלפון הלקוח/הסניף). "" אם לא מופיע או לא קריא',
    },
    invoice_number: {
      type: 'string',
      description: 'מספר החשבונית כפי שמודפס (כולל אותיות/מקפים אם יש). "" אם לא ניתן לקרוא',
    },
    allocation_number: {
      type: 'string',
      description:
        'מספר הקצאה (רשות המסים) — exactly 9 digits, appears near the words "מספר הקצאה"; else ""',
    },
    invoice_date: {
      type: 'string',
      description: 'תאריך החשבונית בפורמט YYYY-MM-DD (המר DD/MM/YYYY או DD.MM.YY). "" אם לא ברור',
    },
    doc_type: {
      type: 'string',
      enum: ['tax_invoice', 'tax_invoice_receipt', 'credit_note', 'unknown'],
      description:
        'סוג המסמך: "חשבונית מס"=tax_invoice, "חשבונית מס/קבלה"=tax_invoice_receipt, ' +
        '"חשבונית זיכוי"=credit_note. unknown when the heading is unreadable',
    },
    amount_before_vat: {
      type: ['number', 'null'],
      description: 'סכום לפני מע"מ — decimal shekels, absolute value (no ₪, no thousands commas)',
    },
    vat_amount: {
      type: ['number', 'null'],
      description: 'סכום המע"מ — decimal shekels, absolute value',
    },
    total_amount: {
      type: ['number', 'null'],
      description: 'סה"כ לתשלום כולל מע"מ — decimal shekels, absolute value',
    },
    lines: {
      type: 'array',
      description: 'שורות הפריטים לפי סדר הופעתן. מערך ריק אם אין טבלת פריטים קריאה',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: 'תיאור הפריט כפי שמודפס בשורה',
          },
          barcode: {
            type: 'string',
            description: 'ברקוד — 12-13 digit EAN as printed; "" when the line has none',
          },
          sku: {
            type: 'string',
            description: 'מק"ט ספק — supplier catalog number, not the barcode; "" when absent',
          },
          quantity: {
            type: ['number', 'null'],
            description:
              'הכמות בעמודת הכמות הראשית כפי שמודפסת (יכולה להיות עשרונית, למשל 2.5 ק"ג). ' +
              'אצל חלק מהספקים זו כמות ארגזים/מארזים ולא יחידות בודדות',
          },
          unit_quantity: {
            type: ['number', 'null'],
            description:
              'מספר היחידות הבודדות בשורה, מעמודה נפרדת כגון "כ.בודד" / "כמות בודד" / "יח\'" / ' +
              '"בודדים" / "סה"כ יחידות". null כשאין בטבלה עמודה כזו',
          },
          unit_cost: {
            type: ['number', 'null'],
            description:
              'מחיר ליחידה בודדת אחת לפני מע"מ — decimal shekels, absolute value. ' +
              'null when no per-single price is printed (the server computes it)',
          },
          pack_cost: {
            type: ['number', 'null'],
            description:
              'המחיר המודפס כשהוא מתייחס לארגז/מארז ולא ליחידה בודדת — decimal shekels. ' +
              'null when the printed price is already per single unit',
          },
          line_total: {
            type: ['number', 'null'],
            description: 'סה"כ לשורה לפני מע"מ — decimal shekels, absolute value',
          },
          confidence: CONFIDENCE,
        },
        required: [
          'name',
          'barcode',
          'sku',
          'quantity',
          'unit_quantity',
          'unit_cost',
          'pack_cost',
          'line_total',
          'confidence',
        ],
      },
    },
    field_confidence: {
      type: 'object',
      additionalProperties: false,
      description: 'רמת הוודאות שבה נקרא כל שדה כותרת',
      properties: {
        supplier_name: CONFIDENCE,
        supplier_phone: CONFIDENCE,
        invoice_number: CONFIDENCE,
        allocation_number: CONFIDENCE,
        invoice_date: CONFIDENCE,
        amount_before_vat: CONFIDENCE,
        vat_amount: CONFIDENCE,
        total_amount: CONFIDENCE,
      },
      required: [
        'supplier_name',
        'supplier_phone',
        'invoice_number',
        'allocation_number',
        'invoice_date',
        'amount_before_vat',
        'vat_amount',
        'total_amount',
      ],
    },
    notes: {
      type: 'string',
      description:
        'הערה קצרה בעברית על כל דבר חריג (עמוד חסר, כתם, סכום מחוק, שורות שלא נקראו). null אם אין',
    },
  },
  required: [
    'supplier_name',
    'supplier_tax_id',
    'supplier_phone',
    'invoice_number',
    'allocation_number',
    'invoice_date',
    'doc_type',
    'amount_before_vat',
    'vat_amount',
    'total_amount',
    'lines',
    'field_confidence',
    'notes',
  ],
};

/**
 * Static extraction instructions. Cached (`cache_control: ephemeral`) — it is byte-identical on
 * every request, so it must never contain per-request data (dates, ids, amounts).
 */
export const SYSTEM_PROMPT = [
  'אתה מחלץ נתונים מצילומים של חשבוניות ספקים ישראליות עבור רשת סופרמרקטים.',
  'The photos are taken on a phone: Hebrew RTL text, possibly folded, dirty, skewed, shadowed or',
  'partially blurred. ALL pages you receive belong to ONE invoice, in page order — merge them.',
  '',
  'כללים:',
  '1. Money: return decimal shekels as JSON numbers. Strip ₪, "ש"ח" and thousands commas',
  '   ("1,234.56" → 1234.56). Never return money as a string.',
  '2. Return ABSOLUTE values everywhere, also for credit notes ("חשבונית זיכוי") — the sign is',
  '   carried by doc_type alone, and the server applies it.',
  '3. Dates: convert DD/MM/YYYY or DD.MM.YY to YYYY-MM-DD. In Israel the day comes first.',
  '4. מספר הקצאה: only accept a value of exactly 9 digits found near the words "מספר הקצאה" /',
  '   "אישור הקצאה". Anything else → "". Never reuse the invoice number as an allocation number.',
  '5. ברקוד ומק"ט are different fields: a barcode is a 12-13 digit EAN, a מק"ט is the supplier\'s',
  '   own catalog number (often short, may contain letters). Never copy one into the other.',
  '6. עמודות כמות: quantity = הכמות בעמודה הראשית כפי שמודפסת (אצל חלק מהספקים זו כמות',
  '   ארגזים/מארזים או ק"ג, ולא יחידות). אם יש בטבלה עמודה נפרדת הסופרת יחידות בודדות —',
  '   "כ.בודד", "כמות בודד", "יח\'", "בודדים", "סה"כ יחידות" — החזר אותה ב-unit_quantity.',
  '   אין עמודה כזו → unit_quantity = null.',
  '7. מחירים: unit_cost הוא המחיר ליחידה בודדת אחת בלבד. כאשר המחיר המודפס מתייחס לארגז/מארז',
  '   (כלומר קיים unit_quantity השונה מ-quantity) — החזר את המחיר המודפס ב-pack_cost והשאר',
  '   unit_cost = null; השרת יחשב סה"כ נטו חלקי unit_quantity. אל תחלק בעצמך.',
  '   גם כשאין עמודת יחידות ואין מחיר מודפס — השאר unit_cost null והשרת יחשב.',
  '8. Never guess an unreadable value: return "" for a text field, null for a number, and mark',
  '   that field confidence "low". Text fields are never null — an unknown one is an empty string.',
  '   A wrong number is far worse than a missing one — a human reviews every draft.',
  '9. Read every item row you can, in order. Skip subtotal/discount/deposit summary rows that are',
  '   not products, and mention them in notes.',
  '10. notes: Hebrew, one short sentence, for anything unusual — otherwise "".',
].join('\n');

/** Image media types the API accepts; anything else is sent as an image/jpeg guess. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Short Hebrew task text, sent after the pages. */
const TASK_TEXT =
  'כל העמודים המצורפים שייכים לחשבונית אחת. חלץ את נתוני הכותרת ואת כל שורות הפריטים לפי הסכימה.';

/**
 * Build the `messages.create` params for one invoice.
 *
 * PDFs (Genius Scan output) go in as document blocks, photos as image blocks, in page order,
 * followed by the Hebrew task text. No `thinking` key (adaptive is the default on claude-opus-5)
 * and no temperature — both are rejected by the model.
 *
 * @param {Array<{buffer: Buffer, contentType: string}>} pages page objects in page order
 * @returns {object} params for `client.messages.create(...)`
 */
export function buildExtractionRequest(pages) {
  const content = (pages || []).map(({ buffer, contentType }) => {
    const data = Buffer.from(buffer).toString('base64');
    if (contentType === 'application/pdf') {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      };
    }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: IMAGE_TYPES.has(contentType) ? contentType : 'image/jpeg',
        data,
      },
    };
  });
  content.push({ type: 'text', text: TASK_TEXT });

  return {
    model: config.ai.extractModel,
    max_tokens: config.ai.extractMaxTokens,
    output_config: {
      effort: config.ai.extractEffort,
      format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
    },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  };
}
