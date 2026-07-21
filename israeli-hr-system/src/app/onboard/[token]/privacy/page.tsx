import { prisma } from "@/lib/prisma";
import { PrivacyPolicy } from "@/components/PrivacyPolicy";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: { absolute: "מדיניות פרטיות" } };
}

// ח.פ. של יניב רום יזמות — המשרד המרכזי המפעיל את המערכת עבור כל החברות.
const CENTRAL_OFFICE_NUMBER = "515325405";

export default async function PrivacyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await prisma.onboardingInvite
    .findUnique({ where: { token } })
    .catch(() => null);

  // פרטי החברה נשלפים דינמית לפי החברה שנבחרה בקישור.
  const company = invite?.companyName
    ? await prisma.company.findUnique({ where: { name: invite.companyName } }).catch(() => null)
    : null;

  const companyName = company?.name || invite?.companyName || "החברה המעסיקה";
  const isCentralOffice = company?.companyNumber === CENTRAL_OFFICE_NUMBER;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
        <PrivacyPolicy
          companyName={companyName}
          companyNumber={company?.companyNumber}
          address={company?.address}
          isCentralOffice={isCentralOffice}
        />
      </div>
    </div>
  );
}
