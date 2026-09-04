import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaItem } from "@/types/library-item";
import { normalizeTitleForMatching } from "@/lib/title-normalization";

// Stage 27 — moved to a shared, server/client-neutral module
// (title-normalization.ts has no "server-only" marker) so Stage 27's
// client-side duplicate detection (lib/duplicate-detection.ts) can reuse
// the exact same implementation instead of a second, subtly-different
// one. Re-exported here so every existing importer of
// `normalizeTitleForMatching` from this file keeps working unchanged.
export { normalizeTitleForMatching };

export type SmartAutoLinkOutcome =
  | { kind: "matched"; libraryItemId: string }
  | { kind: "ambiguous" }
  | { kind: "no_match" };

interface CandidateRow {
  id: string;
  title: string;
}

/**
 * Attempts to find a single, safe, automatic link for a newly detected
 * source. Only ever called when no tracking_sources mapping exists yet
 * (see /api/extension/progress) — an established mapping is never
 * re-matched by title.
 *
 * Matching priority (weakest signals never used for automatic linking —
 * see the module-level note below on tiers 2 and 4):
 *   1. Existing exact source mapping — handled by the caller before this
 *      function is ever invoked; not this function's concern.
 *   2. Exact authoritative external/catalog identifiers (e.g. an AniList
 *      ID), if both the detected source and a LibraryItem expose a
 *      compatible one. No current adapter or the universal detection
 *      engine emits such an identifier (extension/src/tracking/universal/
 *      only extracts og:title/JSON-LD *name*, canonical URL, and heading/
 *      URL/navigation progress signals — never a work identifier), so
 *      this tier has no candidates to evaluate today. It is listed here,
 *      ahead of title matching, as the intended slot for a future
 *      detector that does expose one — deliberately not stubbed out with
 *      fake logic in the meantime.
 *   3. Exact normalized title + compatible media type, requiring exactly
 *      one candidate — implemented below. This is the tier that does the
 *      real work for every adapter and the universal engine today.
 *   4. Additional strong metadata agreement (e.g. author) to corroborate
 *      a match. Same situation as tier 2: no detector currently supplies
 *      author or other corroborating metadata in the detection payload,
 *      so there is nothing for this tier to check yet. Never required —
 *      per the spec, a unique exact-title match must not be blocked by
 *      the absence of metadata neither side has.
 *   5. Otherwise: "no_match" — the source is recorded but left unlinked,
 *      exactly like today's needs_link behavior.
 *
 * Never fuzzy: only an exact match on the normalized title is considered.
 * A future manual-linking UI may want to *suggest* fuzzy matches, but
 * that is a display concern for the picker, never something this
 * function does — wrong automatic linking is worse than asking.
 */
export async function attemptSmartAutoLink(
  admin: SupabaseClient,
  userId: string,
  mediaType: MediaItem["type"],
  sourceTitle: string,
): Promise<SmartAutoLinkOutcome> {
  const target = normalizeTitleForMatching(sourceTitle);
  if (!target) return { kind: "no_match" };

  // Scoped to this user and this exact media type — a Novel source can
  // never even be considered against an Anime item, regardless of title.
  const { data, error } = await admin
    .from("library_items")
    .select("id, title")
    .eq("user_id", userId)
    .eq("type", mediaType)
    .returns<CandidateRow[]>();
  if (error) throw error;

  const matches = (data ?? []).filter((row) => normalizeTitleForMatching(row.title) === target);

  if (matches.length === 1) return { kind: "matched", libraryItemId: matches[0].id };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "no_match" };
}
