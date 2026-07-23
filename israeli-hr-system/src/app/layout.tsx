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
  themeColor: "#3e4196",
};

// פריסת השורש: מגדירה כיוון RTL ושפה עברית בלבד. סרגל הצד של ה-HR נמצא בפריסת
// קבוצת הנתיבים (app), כדי שעמודים ציבוריים (כמו פורטל הקליטה) לא יציגו אותו.
// מחיל את מצב התצוגה (כהה/בהיר) לפני הצביעה הראשונה — מונע הבהוב.
const themeScript = `try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
