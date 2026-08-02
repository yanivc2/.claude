"use client";

import { usePathname } from "next/navigation";

// עוטף את תוכן העמוד ומפעיל אנימציית כניסה עדינה (fade-up) בכל מעבר עמוד.
// ה-key מבוסס-נתיב גורם ל-remount בכל ניווט — כך האנימציה מתנגנת מחדש.
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="animate-fade-up">
      {children}
    </div>
  );
}
