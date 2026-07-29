import { prisma } from "./prisma";

// זיהוי קישור וידאו (יוטיוב / וימאו / קובץ וידאו) — להפרדת "סרטונים" מ"נהלים".
export function isVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /youtube\.com|youtu\.be|vimeo\.com|\.mp4($|\?)|\.webm($|\?)|\.mov($|\?)/i.test(url);
}

// מזהה סרטון יוטיוב לצורך הטמעה (embed).
export function youtubeId(url: string): string | null {
  const m =
    /youtu\.be\/([\w-]{11})/.exec(url) ||
    /[?&]v=([\w-]{11})/.exec(url) ||
    /youtube\.com\/embed\/([\w-]{11})/.exec(url);
  return m ? m[1] : null;
}

// משאבים מאושרים בהיקף החברה של העובד (כולל פריטים גלובליים ללא שיוך).
export async function employeeResources(companyId: string | null) {
  return prisma.resource
    .findMany({
      where: {
        status: "APPROVED",
        OR: [{ companyId: null }, { companyId: companyId ?? "__none__" }],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        kind: true,
        description: true,
        url: true,
        fileName: true,
        mimeType: true,
        createdAt: true,
      },
      take: 200,
    })
    .catch(() => []);
}
