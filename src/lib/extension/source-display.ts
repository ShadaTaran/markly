import { isValidUrl } from "@/lib/website";
import type { TrackingSourceSummary } from "@/lib/extension/types";

/**
 * Human-readable site/provider names — never a raw implementation id
 * (`universal-reader`, `mangadex`, `markly-season-test`) as the primary
 * label a user sees (see README "Cross-Source Work Identity"). Extend this
 * table as real adapters are added; everything else falls back to the
 * source's own hostname, which is still far more readable than an
 * adapterId even when it isn't in either table below.
 */
const ADAPTER_LABELS: Record<string, string> = {
  mangadex: "MangaDex",
  "markly-test-reader": "Markly Test Reader",
  "markly-test-reader-b": "Markly Test Reader B",
  "markly-season-test": "Markly Season Test",
};

/** For adapterId === "universal-reader" (and any other detector with no adapter-level display name), keyed by hostname — the only signal available. */
const HOSTNAME_LABELS: Record<string, string> = {
  "novelphoenix.com": "NovelPhoenix",
  "mangadex.org": "MangaDex",
};

export function getSourceHostname(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The label a user sees for a tracking source. Adapter-level names win
 * when known; otherwise the source's own hostname (e.g. "novelphoenix.com",
 * or the friendlier "NovelPhoenix" where that mapping is known); the raw
 * adapterId is the last resort, only when neither is available (a source
 * with no parseable URL at all).
 */
export function getSourceDisplayName(adapterId: string, sourceUrl: string | null): string {
  if (ADAPTER_LABELS[adapterId]) return ADAPTER_LABELS[adapterId];
  const hostname = getSourceHostname(sourceUrl);
  if (hostname && HOSTNAME_LABELS[hostname]) return HOSTNAME_LABELS[hostname];
  return hostname ?? adapterId;
}

/**
 * Formats a source's last_detected_progress for display. Never presents an
 * unconfirmed video "episode detected, not yet watched enough" observation
 * (progress.confirmed === false — see README "Episode/Video Tracking") as
 * if it were committed Library progress: it gets an explicit "Detected: …
 * (not completed)" treatment instead of the plain value every confirmed/
 * reading-media detection uses.
 */
export function formatSourceProgress(progress: TrackingSourceSummary["lastDetectedProgress"]): string {
  if (!progress) return "No progress detected yet";
  const value = formatProgressValue(progress);
  return progress.confirmed === false ? `Detected: ${value} (not completed)` : value;
}

function formatProgressValue(progress: NonNullable<TrackingSourceSummary["lastDetectedProgress"]>): string {
  switch (progress.kind) {
    case "season_episode":
      return progress.season !== undefined ? `Season ${progress.season}, Episode ${progress.value}` : `Episode ${progress.value}`;
    case "episode":
      return `Episode ${progress.value}`;
    case "chapter":
      return `Chapter ${progress.value}`;
    case "page":
      return `Page ${progress.value}`;
    case "percent":
      return `${progress.value}%`;
    case "playtime":
      return `${progress.value}h`;
    default:
      return `${progress.kind} ${progress.value}`;
  }
}

/**
 * The one URL "Open Source" is ever allowed to open — prefers the stable
 * work URL Stage 21 may have derived (a chapter/episode page's own URL
 * moves every update; the work URL doesn't) over the latest raw detected
 * page, and validates whichever is used all over again regardless of
 * where it came from: only http/https, never javascript:/data:/file:/
 * malformed — see lib/website.ts's isValidUrl, reused rather than
 * reimplemented. Returns null (render no link at all) when neither is safe.
 */
export function getSafeOpenSourceUrl(source: Pick<TrackingSourceSummary, "sourceUrl" | "lastDetectedMetadata">): string | null {
  const candidate = source.lastDetectedMetadata?.workUrl ?? source.sourceUrl;
  return candidate && isValidUrl(candidate) ? candidate : null;
}
