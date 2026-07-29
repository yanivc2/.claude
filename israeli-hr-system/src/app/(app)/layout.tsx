import { Sidebar } from "@/components/Sidebar";
import { MobileTabBar } from "@/components/MobileTabBar";
import { ChatWidget } from "@/components/ChatWidget";
import { PullToRefresh } from "@/components/PullToRefresh";
import { PageTransition } from "@/components/PageTransition";
import { ViewerProvider } from "@/components/ViewerProvider";
import { redirect } from "next/navigation";
import { currentAdmin, currentEmployee } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { roleOf } from "@/lib/rbac";

// פריסת אזור ה-HR הפנימי: סרגל צד קבוע (במחשב) / תפריט המבורגר (סלולר) + תוכן,
// וכפתור צף של היועץ לזכויות עובדים.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentAdmin();
  // סשן עובד אינו רשאי לאזור הניהול — מפנים לאזור העובד.
  if (!me && (await currentEmployee())) redirect("/my-home");
  const company = me?.companyId
    ? await prisma.company.findUnique({ where: { id: me.companyId }, select: { name: true } })
    : null;
  const viewer = {
    role: me ? roleOf(me) : ("OWNER" as const),
    companyId: me?.companyId ?? null,
    companyName: company?.name ?? null,
  };

  return (
    <ViewerProvider value={viewer}>
      <div className="flex min-h-screen">
        <PullToRefresh />
        <Sidebar />
        <main className="flex-1 overflow-x-hidden pt-14 md:pt-0">
          {/* מרווח תחתון בסלולר כדי שהתוכן לא ייחבא מאחורי סרגל הטאבים */}
          <div className="mx-auto max-w-6xl px-4 py-6 pb-24 sm:px-6 sm:py-8 md:pb-8">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
        <MobileTabBar />
        <ChatWidget />
      </div>
    </ViewerProvider>
  );
}
