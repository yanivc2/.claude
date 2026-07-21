// עזרי ימי הולדת ושליחת ברכה בוואטסאפ.

// המרת מספר טלפון ישראלי לפורמט בינלאומי עבור wa.me (972...).
export function waPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("972")) return d;
  if (d.startsWith("0")) return "972" + d.slice(1);
  return d;
}

// מספר הימים עד יום ההולדת הקרוב (0 = היום).
export function daysUntilBirthday(birthDate: Date, from: Date): number {
  const fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let next = new Date(from.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  if (next.getTime() < fromMidnight.getTime()) {
    next = new Date(from.getFullYear() + 1, birthDate.getMonth(), birthDate.getDate());
  }
  return Math.round((next.getTime() - fromMidnight.getTime()) / 86_400_000);
}

export function birthdayMessage(name: string): string {
  return `היי ${name}, מזל טוב ליום ההולדת! 🎉🎂 כל הצוות מאחל לך יום הולדת שמח ומלא הצלחה.`;
}

// קישור wa.me לשליחת ברכת יום הולדת (null אם אין טלפון תקין).
export function birthdayWaHref(phone: string | null | undefined, name: string): string | null {
  const p = waPhone(phone);
  if (!p) return null;
  return `https://wa.me/${p}?text=${encodeURIComponent(birthdayMessage(name))}`;
}
