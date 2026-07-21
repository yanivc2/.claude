import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "מערכת ניהול משאבי אנוש",
  description: "מערכת HR לשוק הישראלי — עדכוני חקיקה, התייעצות, וקליטה ושימור עובדים",
};

// פריסת השורש: מגדירה כיוון RTL ושפה עברית, ומרנדרת סרגל צד קבוע.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 overflow-x-hidden">
            <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
