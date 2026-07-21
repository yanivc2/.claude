import { prisma } from "@/lib/prisma";
import { OnboardingForm } from "@/components/OnboardingForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await prisma.onboardingInvite
    .findUnique({ where: { token }, select: { companyName: true } })
    .catch(() => null);
  // כותרת מוחלטת (ללא שם המערכת) — זה עמוד ציבורי לעובד.
  const title = invite?.companyName ? `${invite.companyName} — טופס קליטה` : "טופס קליטה לעובד";
  return { title: { absolute: title } };
}

// פורטל קליטה ציבורי: העובד נכנס דרך קישור ההזמנה, ממלא, מעלה מסמכים וחותם.
// אין כאן סרגל צד של HR — העמוד יושב מחוץ לקבוצת הנתיבים (app).
export default async function OnboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await prisma.onboardingInvite
    .findUnique({ where: { token } })
    .catch(() => null);

  if (!invite || invite.status !== "PENDING") {
    const completed = invite?.status === "COMPLETED";
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-4xl">{completed ? "✓" : "⚠️"}</p>
        <h1 className="mt-4 text-xl font-bold text-slate-800">
          {completed ? "הקליטה כבר הושלמה" : "הקישור אינו תקין"}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {completed
            ? "פרטי הקליטה כבר נשלחו למעסיק. אין צורך בפעולה נוספת."
            : "ייתכן שהקישור פג תוקף או כבר נוצל. אנא פנה/י למשאבי אנוש לקבלת קישור חדש."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">
          {invite.companyName ? `${invite.companyName} — טופס קליטה` : "טופס קליטה לעובד"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          ברוך/ה הבא/ה! אנא מלא/י את הפרטים, העלה/י צילום ספח ת.ז וחתום/מי על טופס 101 ועל
          הסכם העבודה. בסיום, הפרטים יישלחו ישירות למעסיק.
        </p>
      </header>

      <OnboardingForm
        endpoint={`/api/onboard/${token}`}
        defaults={{
          firstName: invite.firstName ?? "",
          lastName: invite.lastName ?? "",
          email: invite.email ?? "",
        }}
        agreement={
          invite.contractFileData && invite.contractFileName
            ? {
                fileName: invite.contractFileName,
                dataUrl: invite.contractFileData,
                mimeType: invite.contractMimeType ?? undefined,
              }
            : undefined
        }
        doneMessage="תודה! פרטי הקליטה נשלחו בהצלחה למעסיק. אין צורך בפעולה נוספת."
      />
    </div>
  );
}
