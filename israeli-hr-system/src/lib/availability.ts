// זמינות עובד לפי ימים ומשמרות. משותף לטופס הקליטה ולתצוגת תיק העובד.

export const AVAILABILITY_DAYS = [
  { key: "sun", label: "ראשון" },
  { key: "mon", label: "שני" },
  { key: "tue", label: "שלישי" },
  { key: "wed", label: "רביעי" },
  { key: "thu", label: "חמישי" },
  { key: "fri", label: "שישי" },
  { key: "sat", label: "שבת" },
] as const;

export const AVAILABILITY_SHIFTS = [
  { key: "morning", label: "בוקר" },
  { key: "evening", label: "ערב" },
  { key: "night", label: "לילה" },
] as const;

// מבנה: מפתח-יום → רשימת מפתחות-משמרת. לדוגמה: { sun: ["morning","night"] }
export type Availability = Record<string, string[]>;

// המרה לטקסט קריא: "ראשון: בוקר, לילה · שלישי: ערב"
export function formatAvailability(a: unknown): string {
  if (!a || typeof a !== "object") return "—";
  const map = a as Record<string, unknown>;
  const parts: string[] = [];
  for (const day of AVAILABILITY_DAYS) {
    const shifts = map[day.key];
    if (Array.isArray(shifts) && shifts.length) {
      const labels = shifts
        .map((s) => AVAILABILITY_SHIFTS.find((x) => x.key === s)?.label ?? String(s))
        .join(", ");
      parts.push(`${day.label}: ${labels}`);
    }
  }
  return parts.length ? parts.join(" · ") : "—";
}
