import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // תבנית כותרת: כותרת העמוד מתווספת לשם המערכת בכותרת הטאב בדפדפן.
  title: {
    default: "מערכת ניהול משאבי אנוש",
    template: "%s · מערכת משאבי אנוש",
  },
  description: "מערכת HR לשוק הישראלי — עדכוני חקיקה, התייעצות, וקליטה ושימור עובדים",
  manifest: "/manifest.webmanifest",
  // הגדרות iOS: פתיחה במסך מלא (כמו אפליקציה) עם שם וסרגל מצב תואמים.
  appleWebApp: {
    capable: true,
    title: "משאבי אנוש",
    statusBarStyle: "default",
  },
};

// צבע סרגל הכתובת/מצב במובייל — בגוון המותג.
export const viewport: Viewport = {
  themeColor: "#1e40af",
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
