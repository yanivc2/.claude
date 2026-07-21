import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "מערכת ניהול משאבי אנוש",
  description: "מערכת HR לשוק הישראלי — עדכוני חקיקה, התייעצות, וקליטה ושימור עובדים",
};

// פריסת השורש: מגדירה כיוון RTL ושפה עברית בלבד. סרגל הצד של ה-HR נמצא בפריסת
// קבוצת הנתיבים (app), כדי שעמודים ציבוריים (כמו פורטל הקליטה) לא יציגו אותו.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
