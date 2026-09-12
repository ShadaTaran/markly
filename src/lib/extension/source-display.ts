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

/** Stage 40 — the reserved adapterId for a user-entered "Add Source" row (never a real extension adapter — see extension/src/adapters/*, none of which use it). */
export const MANUAL_SOURCE_ADAPTER_ID = "manual";

/**
 * The label a user sees for a tracking source.
 *
 * For a manual (Stage 40 Add Source) row, the user's own chosen label
 * always wins — that label is the entire point of typing one in. For an
 * extension-detected row, `sourceTitle` remains what it always was (an
 * auto-captured page title, e.g. "Chapter 42 - MangaDex" — often less
 * readable than the site name) and is deliberately NOT preferred here, so
 * this change cannot regress how any existing detected source already
 * displays: adapter-level names still win when known; otherwise the
 * source's own hostname (e.g. "novelphoenix.com", or the friendlier
 * "NovelPhoenix" where that mapping is known); the raw adapterId is the
 * last resort, only when neither is available (a source with no parseable
 * URL at all).
 */
export function getSourceDisplayName(adapterId: string, sourceUrl: string | null, sourceTitle?: string): string {
  if (adapterId === MANUAL_SOURCE_ADAPTER_ID && sourceTitle) return sourceTitle;
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
 * True when two URLs share the same trusted host — www.-normalized exact
 * hostname equality (reusing getSourceHostname, the same normalization
 * already used for display), never a broader "same site" notion. No
 * Public Suffix List, no sibling-subdomain allowance: the tracking
 * architecture has no adapter that legitimately needs one (MangaDex's own
 * adapter, for instance, only ever matches an exact hostname — see
 * MANGADEX_HOSTNAMES). A bare hostname comparison also keeps a dev
 * `localhost` TrackingSource working regardless of port.
 */
function sameTrustedHost(urlA: string, urlB: string): boolean {
  const hostA = getSourceHostname(urlA);
  const hostB = getSourceHostname(urlB);
  return hostA !== null && hostB !== null && hostA === hostB;
}

/**
 * The one URL "Open Source"/Dashboard Continue is ever allowed to open.
 *
 * Trust invariant (Stage 32 correctness review): lastDetectedMetadata.
 * workUrl is written from page-observed signals (a same-site anchor a
 * trusted adapter matched, or a path segment stripped from the tracked
 * page's own URL — see extension/src/tracking/universal/detected-
 * metadata.ts and adapters/mangadex.ts, both of which can only ever
 * produce a same-origin value today) but the SERVER'S OWN validation
 * (lib/extension/detected-metadata.ts's parseHttpUrl) only checks that
 * it's a well-formed http/https URL — it does not, and structurally
 * cannot, know whether a future adapter or a direct API caller kept that
 * same-origin guarantee. Rather than trust that upstream invariant
 * forever, this function re-derives it at the one place a workUrl gains
 * real navigation authority: workUrl is only ever used when it shares
 * sourceUrl's own trusted host (sameTrustedHost, above). A workUrl for an
 * unrelated host is silently ignored — never opened, never surfaced as
 * an error — falling back to sourceUrl exactly as if no workUrl had ever
 * been detected. sourceUrl on its own still passes through the same
 * isValidUrl check every external target requires (only http/https,
 * never javascript:/data:/file:/credential-bearing/malformed).
 */
export function getSafeOpenSourceUrl(source: Pick<TrackingSourceSummary, "sourceUrl" | "lastDetectedMetadata">): string | null {
  const safeSourceUrl = source.sourceUrl && isValidUrl(source.sourceUrl) ? source.sourceUrl : null;

  const workUrl = source.lastDetectedMetadata?.workUrl;
  if (workUrl && isValidUrl(workUrl) && safeSourceUrl && sameTrustedHost(workUrl, safeSourceUrl)) {
    return workUrl;
  }

  return safeSourceUrl;
}
