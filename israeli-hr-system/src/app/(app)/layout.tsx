import { Sidebar } from "@/components/Sidebar";

// פריסת אזור ה-HR הפנימי: סרגל צד קבוע (במחשב) / תפריט המבורגר (סלולר) + תוכן.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-x-hidden pt-14 md:pt-0">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</div>
      </main>
    </div>
  );
}
