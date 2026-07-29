import { redirect } from "next/navigation";
import { currentEmployee, currentAdmin } from "@/lib/session";
import { EmployeeHeader } from "@/components/EmployeeHeader";
import { EmployeeTabBar } from "@/components/EmployeeTabBar";
import { PageTransition } from "@/components/PageTransition";

// פריסת אזור העובד (self-service, מובייל-first): סרגל עליון + תוכן ממורכז צר
// + סרגל טאבים תחתון. שומר שרק סשן עובד ניגש — מנהל מנותב לדשבורד, אורח לכניסה.
export default async function EmployeeLayout({ children }: { children: React.ReactNode }) {
  const me = await currentEmployee();
  if (!me) {
    if (await currentAdmin()) redirect("/");
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      <EmployeeHeader name={me.firstName} />
      <main className="mx-auto max-w-md px-4 pb-28 pt-16">
        <PageTransition>{children}</PageTransition>
      </main>
      <EmployeeTabBar />
    </div>
  );
}
