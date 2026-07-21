import { ImageResponse } from "next/og";
import { BRIEFCASE_DATA_URI, ICON_BACKGROUND } from "@/lib/brandIcon";

// אייקון הדפדפן (favicon) + אייקון המניפסט (אנדרואיד).
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
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
        <img src={BRIEFCASE_DATA_URI} width={300} height={300} alt="" />
      </div>
    ),
    { ...size },
  );
}
