// נכסי האייקון של האפליקציה — משותפים ל-favicon, לאייקון iOS ולמניפסט.
// הסמל הוא תיק־עבודה לבן (מייצג משאבי אנוש) על רקע גרדיאנט בצבע המותג.
// אין תלות בגופן, כך שהאייקון נוצר תמיד נכון. להחלפה בלוגו שלך: החלף את
// BRIEFCASE_SVG ב-data URI של התמונה שלך (או המר את קבצי icon/apple-icon
// לקבצי PNG סטטיים).

const BRIEFCASE_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' " +
  "stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
  "<rect x='2' y='7' width='20' height='14' rx='2'/>" +
  "<path d='M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'/>" +
  "<path d='M2 13h20'/></svg>";

export const BRIEFCASE_DATA_URI = `data:image/svg+xml,${encodeURIComponent(BRIEFCASE_SVG)}`;

// רקע האייקון — גרדיאנט בין גווני המותג (brand-500 → brand-700).
export const ICON_BACKGROUND = "linear-gradient(135deg, #2563eb, #1e40af)";
