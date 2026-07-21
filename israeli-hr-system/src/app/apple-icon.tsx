import { ImageResponse } from "next/og";
import { BRIEFCASE_DATA_URI, ICON_BACKGROUND } from "@/lib/brandIcon";

// אייקון מסך הבית ב-iOS (apple-touch-icon). iOS מעגל את הפינות בעצמו.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          background: ICON_BACKGROUND,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BRIEFCASE_DATA_URI} width={104} height={104} alt="" />
      </div>
    ),
    { ...size },
  );
}
