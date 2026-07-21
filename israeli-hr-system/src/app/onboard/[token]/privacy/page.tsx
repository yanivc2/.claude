import { prisma } from "@/lib/prisma";
import { PrivacyPolicy } from "@/components/PrivacyPolicy";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: { absolute: "מדיניות פרטיות" } };
}

// פרטי איש הקשר לפניות פרטיות (מרכזי — משותף לכל החברות).
const CONTACT = { person: "יניב כהן", phone: "052-6850015", email: "yanivc2@gmail.com" };

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

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
        <PrivacyPolicy
          companyName={companyName}
          companyNumber={company?.companyNumber}
          address={company?.address}
          contactPerson={CONTACT.person}
          contactPhone={CONTACT.phone}
          contactEmail={CONTACT.email}
          retentionYears={7}
        />
      </div>
    </div>
  );
}
