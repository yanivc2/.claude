// עזרי שיתוף משותפים — וואטסאפ (Web Share עם נפילה ל-wa.me) ומייל (mailto).
// אותו מנגנון שתוקן לשיתוף פרטי משתמש חדש (בורר אנשי קשר + טקסט מוכן).

export async function shareWhatsApp(text: string) {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      // ביטול ע"י המשתמש — לא עושים כלום; שגיאה אחרת — נופלים לקישור וואטסאפ.
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
}

export function mailtoHref(subject: string, body: string, to = ""): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
