import { ImageResponse } from "next/og";

// Stage 38 — a dedicated Apple touch icon, intentionally NOT the same
// rounded-square composition as icon.svg/the PWA manifest icons: iOS
// applies its own corner mask (and, on older versions, a specular
// highlight) to whatever is provided here, so pre-baking rounded corners
// would produce a visibly double-rounded icon on the Home Screen. This is a
// flat, full-bleed, fully opaque square — exactly what Apple's own
// guidance calls for.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const BOOKMARK_PATH =
  "M7 2a2 2 0 0 0-2 2v17a1 1 0 0 0 1.55.83L12 17.9l5.45 3.93A1 1 0 0 0 19 21V4a2 2 0 0 0-2-2H7z";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        <svg width={180} height={180} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <rect width="32" height="32" fill="#3b82f6" />
          <path transform="translate(4 4)" fill="#ffffff" d={BOOKMARK_PATH} />
        </svg>
      </div>
    ),
    { ...size },
  );
}
