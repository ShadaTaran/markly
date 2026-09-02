import { extractFromUrl } from "./url";
import { extractFromHeadings } from "./headings";
import { parseProgressText } from "./progress";
import { extractMetadata } from "./metadata";
import { extractNavigation } from "./navigation";
import { scoreSignals, SIGNAL_WEIGHTS } from "./confidence";
import { detectUniversal, UNIVERSAL_DETECTOR_ID } from "./detect";

/**
 * Development-only visibility into *why* universal detection did or did
 * not fire on a page — never sent to Markly's backend, never shown in the
 * ordinary popup UX, and never more than the same narrow, structural
 * signals detectUniversal itself already reads (URL shape, heading text,
 * document.title, a couple of meta/JSON-LD fields, prev/next hrefs). No
 * page HTML, cookies, passwords, or unrelated content is ever included
 * here — this mirrors exactly what detectUniversal looked at, just
 * reported back instead of silently discarded.
 */
export interface DetectionDiagnostics {
  detector: typeof UNIVERSAL_DETECTOR_ID;
  candidateTitle: string | null;
  candidateProgress: { kind: "chapter" | "episode"; value: number } | null;
  confidence: number;
  agreeingSignals: { name: "url" | "heading" | "title" | "metadata" | "navigation"; value: number; weight: number }[];
  decision: "confident" | "low_confidence" | "no_title";
}

/**
 * Recomputes the same signal extraction detectUniversal performs (cheap —
 * a handful of querySelector calls, run once per page load, never in a
 * loop) purely to build a human-readable report. Never called by
 * detectUniversal itself, so the core detector stays a pure function with
 * no logging side effects; only the content script calls this, and only
 * to console.debug the result locally for development.
 */
export function describeDetection(document: Document, url: URL): DetectionDiagnostics {
  const urlMatch = extractFromUrl(url);
  const headingMatch = extractFromHeadings(document);
  const titleMatch = parseProgressText(document.title);
  const metadata = extractMetadata(document);
  const metadataMatch = parseProgressText(metadata.ogTitle) ?? parseProgressText(metadata.jsonLdName);
  const navigation = extractNavigation(document, url);

  const result = scoreSignals({ url: urlMatch, heading: headingMatch, title: titleMatch, metadata: metadataMatch, navigation });

  const agreeingSignals: DetectionDiagnostics["agreeingSignals"] = [];
  if (result.value !== null) {
    if (urlMatch?.value === result.value) agreeingSignals.push({ name: "url", value: urlMatch.value, weight: SIGNAL_WEIGHTS.url });
    if (headingMatch?.value === result.value) agreeingSignals.push({ name: "heading", value: headingMatch.value, weight: SIGNAL_WEIGHTS.heading });
    if (titleMatch?.value === result.value) agreeingSignals.push({ name: "title", value: titleMatch.value, weight: SIGNAL_WEIGHTS.title });
    if (metadataMatch?.value === result.value) agreeingSignals.push({ name: "metadata", value: metadataMatch.value, weight: SIGNAL_WEIGHTS.metadata });
    const navigationAgrees = navigation.prevValue === result.value - 1 || navigation.nextValue === result.value + 1;
    if (navigationAgrees) agreeingSignals.push({ name: "navigation", value: result.value, weight: SIGNAL_WEIGHTS.navigation });
  }

  const detection = detectUniversal(document, url);
  const decision: DetectionDiagnostics["decision"] = detection ? "confident" : result.confident ? "no_title" : "low_confidence";

  return {
    detector: UNIVERSAL_DETECTOR_ID,
    candidateTitle: detection?.sourceTitle ?? null,
    candidateProgress: result.value !== null && result.kind !== null ? { kind: result.kind, value: result.value } : null,
    confidence: result.score,
    agreeingSignals,
    decision,
  };
}

/** Formats a diagnostics report for console.debug — compact, human-scannable, never sent anywhere. */
export function formatDiagnostics(diagnostics: DetectionDiagnostics): string {
  const signals = diagnostics.agreeingSignals.map((s) => `${s.name}=${s.weight}`).join(", ") || "none";
  const progress = diagnostics.candidateProgress ? `${diagnostics.candidateProgress.kind} ${diagnostics.candidateProgress.value}` : "none";
  return [
    `[Markly] detector=${diagnostics.detector}`,
    `title=${diagnostics.candidateTitle ?? "none"}`,
    `progress=${progress}`,
    `confidence=${diagnostics.confidence}`,
    `signals=[${signals}]`,
    `decision=${diagnostics.decision}`,
  ].join(" | ");
}
