// מקור אמת יחיד לסוגי נהלי המשמרת — משמש את ה-API (ולידציה) ואת ה-UI (תצוגה).
// הסדר כאן הוא הסדר שבו הסוגים מוצגים בתפריט הבחירה.
export const PROCEDURE_TYPES = [
  "OPEN",
  "CLOSE",
  "MORNING",
  "EVENING",
  "NIGHT",
  "FRIDAY",
  "SATURDAY",
  "WEEKEND",
  "HOLIDAY_EVE",
  "HOLIDAY",
  "STORE_OPEN",
  "STORE_CLOSE",
] as const;

export type ProcedureTypeKey = (typeof PROCEDURE_TYPES)[number];

export const PROCEDURE_TYPE_LABEL: Record<ProcedureTypeKey, string> = {
  OPEN: "פתיחת משמרת",
  CLOSE: "סגירת משמרת",
  MORNING: "משמרת בוקר",
  EVENING: "משמרת ערב",
  NIGHT: "משמרת לילה",
  FRIDAY: "יום שישי",
  SATURDAY: "יום שבת",
  WEEKEND: "שישישבת",
  HOLIDAY_EVE: "ערב חג",
  HOLIDAY: "חג",
  STORE_OPEN: "נוהל פתיחת החנות",
  STORE_CLOSE: "נוהל סגירת החנות",
};

// תווית בטוחה — נסוגה למפתח עצמו אם התקבל ערך לא צפוי (רשומה ישנה וכד').
export function procedureTypeLabel(type: string): string {
  return PROCEDURE_TYPE_LABEL[type as ProcedureTypeKey] ?? type;
}
