import type { MetadataRoute } from "next";

// מניפסט אפליקציית הרשת — מאפשר התקנה למסך הבית (אנדרואיד) ופתיחה במסך מלא.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "מערכת ניהול משאבי אנוש",
    short_name: "משאבי אנוש",
    description: "מערכת HR לשוק הישראלי — קליטה, שימור ועדכוני חקיקה",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#3e4196",
    dir: "rtl",
    lang: "he",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
