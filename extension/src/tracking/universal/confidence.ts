import type { ProgressTextMatch } from "./progress";
import type { NavigationInfo } from "./navigation";

/**
 * Explainable confidence scoring — never "track because a page contains
 * a number." Each independent signal that found a chapter/episode number
 * contributes a fixed weight to whichever value it found; the value with
 * the most agreeing weight wins, but only if at least two independent
 * signals actually agree on it (a single signal — e.g. a URL match alone
 * — is not enough on its own, exactly to avoid cases like a page
 * containing "Views: 234000" being mistaken for progress by some other
 * lone heuristic). Navigation never establishes the value by itself; it
 * only adds weight once url/heading/title/metadata have already agreed
 * on one.
 */
export interface SignalInput {
  url: ProgressTextMatch | null;
  heading: ProgressTextMatch | null;
  title: ProgressTextMatch | null;
  metadata: ProgressTextMatch | null;
  navigation: NavigationInfo;
}

export interface ConfidenceResult {
  value: number | null;
  kind: "chapter" | "episode" | null;
  score: number;
  agreementCount: number;
  confident: boolean;
}

/** Documented, simple, and deliberately conservative — see module doc comment. */
export const SIGNAL_WEIGHTS = {
  url: 35,
  heading: 30,
  title: 20,
  metadata: 15,
  navigation: 20,
} as const;

export const CONFIDENCE_THRESHOLD = 55;
export const MIN_AGREEING_SIGNALS = 2;

type PrimarySource = "url" | "heading" | "title" | "metadata";

export function scoreSignals(input: SignalInput): ConfidenceResult {
  const primary: { source: PrimarySource; value: number; kind: "chapter" | "episode" }[] = [];
  if (input.url) primary.push({ source: "url", value: input.url.value, kind: input.url.kind });
  if (input.heading) primary.push({ source: "heading", value: input.heading.value, kind: input.heading.kind });
  if (input.title) primary.push({ source: "title", value: input.title.value, kind: input.title.kind });
  if (input.metadata) primary.push({ source: "metadata", value: input.metadata.value, kind: input.metadata.kind });

  if (primary.length === 0) {
    return { value: null, kind: null, score: 0, agreementCount: 0, confident: false };
  }

  const totals = new Map<number, { weight: number; count: number; kind: "chapter" | "episode" }>();
  for (const signal of primary) {
    const existing = totals.get(signal.value);
    if (existing) {
      existing.weight += SIGNAL_WEIGHTS[signal.source];
      existing.count += 1;
    } else {
      totals.set(signal.value, { weight: SIGNAL_WEIGHTS[signal.source], count: 1, kind: signal.kind });
    }
  }

  let bestValue: number | null = null;
  let best = { weight: 0, count: 0, kind: "chapter" as "chapter" | "episode" };
  for (const [value, totalsForValue] of totals) {
    if (totalsForValue.weight > best.weight) {
      bestValue = value;
      best = totalsForValue;
    }
  }

  if (bestValue === null) {
    return { value: null, kind: null, score: 0, agreementCount: 0, confident: false };
  }

  let score = best.weight;
  const navigationAgrees = input.navigation.prevValue === bestValue - 1 || input.navigation.nextValue === bestValue + 1;
  if (navigationAgrees) score += SIGNAL_WEIGHTS.navigation;

  const confident = best.count >= MIN_AGREEING_SIGNALS && score >= CONFIDENCE_THRESHOLD;

  return { value: bestValue, kind: best.kind, score, agreementCount: best.count, confident };
}
