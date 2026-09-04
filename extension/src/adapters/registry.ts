import type { TrackingAdapter } from "./types";
import { marklyTestReaderAdapter } from "./markly-test-reader";
import { mangadexAdapter } from "./mangadex";
import { marklySeasonTestAdapter } from "./markly-season-test";

/**
 * Every supported site, in one place. Stage 19 adds a real adapter (e.g.
 * novelphoenix.ts) by writing matches()/detect() and adding it here —
 * nothing in background/content/popup needs to change, and nothing here
 * needs to change in them either.
 */
export const adapters: readonly TrackingAdapter[] = [marklyTestReaderAdapter, mangadexAdapter, marklySeasonTestAdapter];

export function findMatchingAdapter(url: URL): TrackingAdapter | null {
  return adapters.find((adapter) => adapter.matches(url)) ?? null;
}
