import type { LibraryItem, MediaItem } from "@/types/library-item";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { isMediaItem, getItemHref } from "@/lib/item-detail";
import { isValidUrl } from "@/lib/website";
import { getSafeOpenSourceUrl, getSourceDisplayName, getSourceHostname, formatSourceProgress } from "@/lib/extension/source-display";

/**
 * Stage 41 — the one authoritative "where does Continue/Resume go" engine,
 * reused by Dashboard, Item Detail, Reminders, and Source Hub's own subtle
 * "most recently used" indicator. Moved out of lib/dashboard.ts (which
 * pre-Stage-41 was the only caller and so seemed like a natural home) since
 * that framing was itself the bug this stage exists to fix: Item Detail's
 * OWN primary action, and Library's card overflow menu, had each grown a
 * SECOND and THIRD independent "what URL do I open" implementation
 * (`media?.sourceUrl` directly, bypassing TrackingSources entirely — see
 * the Stage 41 audit report). Every surface must now call the functions in
 * THIS file, never re-derive the answer itself.
 *
 * No new database field, no new migration: everything here is computed
 * fresh from already-existing TrackingSourceSummary/LibraryItem fields,
 * every render, from whatever the current live query returned — so merge,
 * recovery/undo, and backup restore all naturally produce a correct
 * Continue target with zero Stage-41-specific code of their own (§45/§46
 * of the governing brief). Nothing here is ever persisted.
 */

// ============================================================
// Source selection — the part of the engine that does NOT need to know
// the parent LibraryItem's type/status, so Source Hub's own "most
// recently used" indicator can call it directly against the sources list
// it already has, with no new fetch and no full item required.
// ============================================================

export type SourceSelectionResult =
  | { kind: "direct"; source: TrackingSourceSummary; url: string }
  | { kind: "choose_source"; sources: TrackingSourceSummary[] }
  | { kind: "none" };

/**
 * Deterministic tie-break for a set of sources already known to be
 * eligible (linked to this item, safe URL) — most recently seen first,
 * then id ascending so two sources seen at the identical instant still
 * resolve to one answer every time. Reused as the DISPLAY order for a
 * chooser's rows too, even when the underlying value isn't trusted enough
 * to auto-pick one (see selectContinueSource below) — "most recent first"
 * is still the most useful order to show a human, it's only the SILENT
 * auto-pick that requires the stronger guarantee.
 */
function byRecencyThenId(a: TrackingSourceSummary, b: TrackingSourceSummary): number {
  const byLastSeen = b.lastSeenAt.localeCompare(a.lastSeenAt);
  if (byLastSeen !== 0) return byLastSeen;
  return a.id.localeCompare(b.id);
}

/**
 * Picks the single best eligible TrackingSource for an item, or null if
 * none qualifies. Eligible = linked to this item (library_item_id ===
 * item.id) AND has a URL that survives getSafeOpenSourceUrl's own
 * validation. Deterministic tie-break: most recently seen first.
 *
 * UNCHANGED from its pre-Stage-41 form (lib/dashboard.ts) — kept as its
 * own export because it's still exactly the right question to ask when
 * the caller already knows every eligible source's last_seen_at IS a
 * trustworthy recency signal (see selectContinueSource's own doc comment
 * for when that stops being true). Do not inline this into
 * selectContinueSource — TrackingSettingsPanel and other pre-Stage-41
 * call sites may still reasonably want "just the most recent one",
 * unconditionally, for contexts that aren't the user-facing Continue
 * action.
 */
export function selectBestTrackingSource(sources: readonly TrackingSourceSummary[], itemId: string): TrackingSourceSummary | null {
  const eligible = sources.filter((source) => source.libraryItemId === itemId);
  const withSafeUrl = eligible.filter((source) => getSafeOpenSourceUrl(source) !== null);
  if (withSafeUrl.length === 0) return null;
  return [...withSafeUrl].sort(byRecencyThenId)[0];
}

/**
 * Stage 41 §30/§31 — the central correctness finding of this stage.
 * `last_seen_at` does NOT mean the same thing for every source origin:
 *
 *   - Extension-detected source (`recordDetection`, lib/extension/
 *     tracking-sources.ts): updated on every real detection — a genuine
 *     "the user was just observed reading/watching here" signal.
 *   - Manual source (`createManualSource`/`restoreTrackingSource`, Stage
 *     40): `last_seen_at` is set to `now()` exactly ONCE, at creation —
 *     `linkSource` (the only other write path that can touch a manual
 *     row) never updates it, and nothing updates it again after that.
 *     For a manual row this timestamp means "time added/linked", not
 *     "time consumed" — a source pasted in thirty seconds ago would
 *     otherwise look "more recently used" than a source the user has
 *     genuinely been reading from for a week, purely because adding it
 *     is more recent than the last real visit to the other one.
 *
 * `selectBestTrackingSource` (above) doesn't know this distinction and
 * was never audited against it — it was written when Source Hub only
 * ever had extension-detected rows to sort. It remains correct and
 * unchanged for that case. `selectContinueSource` adds exactly the one
 * guard that case never needed: it only trusts `last_seen_at` enough to
 * silently pick a winner when every eligible candidate's timestamp is a
 * genuine consumption signal — i.e. there is no manual-adapter source in
 * the eligible set — or when there's only one candidate at all, where
 * there's nothing to compare in the first place. Otherwise it returns
 * `choose_source` and lets the human decide, rather than silently opening
 * a source they've never actually visited.
 */
export function selectContinueSource(sources: readonly TrackingSourceSummary[], itemId: string): SourceSelectionResult {
  const eligible = sources.filter((source) => source.libraryItemId === itemId && getSafeOpenSourceUrl(source) !== null);
  if (eligible.length === 0) return { kind: "none" };

  if (eligible.length === 1) {
    const source = eligible[0];
    return { kind: "direct", source, url: getSafeOpenSourceUrl(source)! };
  }

  const allGenuinelyTimestamped = eligible.every((source) => source.adapterId !== "manual");
  if (allGenuinelyTimestamped) {
    const best = [...eligible].sort(byRecencyThenId)[0];
    return { kind: "direct", source: best, url: getSafeOpenSourceUrl(best)! };
  }

  return { kind: "choose_source", sources: [...eligible].sort(byRecencyThenId) };
}

/**
 * Stage 41.1 — separates two questions Source Hub's "Most recently used"
 * badge previously conflated:
 *   1. "Can Markly deterministically open this source?" — resume
 *      determinism, answered by selectContinueSource's `direct` kind. A
 *      single eligible source always answers this "yes", trivially,
 *      because there's nothing to disambiguate it from.
 *   2. "Do we have genuine evidence this specific source was actually
 *      used recently?" — usage evidence. A single MANUAL source answers
 *      (1) with "yes" but answers (2) with "no": its last_seen_at is a
 *      creation/link timestamp (set once, by createManualSource /
 *      restoreTrackingSource / linkSource), never a consumption
 *      timestamp — see selectContinueSource's own doc comment. A source
 *      pasted in thirty seconds ago must not be labeled "Most recently
 *      used" merely because it also happens to be the only/direct target.
 *
 * This function answers question (2) alone, and is the ONLY thing
 * ItemTrackingSourcesSection's badge may consult. It deliberately does
 * NOT overload ResumeTarget.kind/selectContinueSource itself with this
 * meaning — "direct" continues to mean only "deterministically
 * resolvable", exactly as Continue/Resume needs it to.
 */
export function selectRecentlyUsedSource(sources: readonly TrackingSourceSummary[], itemId: string): TrackingSourceSummary | null {
  const selection = selectContinueSource(sources, itemId);
  if (selection.kind !== "direct") return null; // ambiguous (or none) — no genuine winner to badge
  if (selection.source.adapterId === "manual") return null; // resolvable, but its timestamp proves nothing about actual use
  return selection.source;
}

// ============================================================
// Action label engine (Stage 41 §24) — one place that decides the verb
// phrase for every surface, driven only by fields that actually exist
// (item.type, item.status). Never invents progress or a status Markly
// doesn't have; movie's own TRACKING_STATUS_OPTIONS (lib/tracking.ts)
// only ever offers "planned"/"completed" through the UI, but `status` is
// not narrowed at the type level, so every branch below stays meaningful
// even for a movie row that somehow holds "in_progress"/"on_hold"/
// "dropped" — same verb table as anime/series, never a special case.
// ============================================================
const CONTINUE_VERB: Record<MediaItem["type"], string> = {
  anime: "watching",
  series: "watching",
  movie: "watching",
  manga: "reading",
  novel: "reading",
  game: "playing",
};

/**
 * Short, reusable action-button text — deliberately NOT combined with
 * progress context ("Continue reading · Chapter 48"): every surface that
 * needs progress context already shows it separately via
 * lib/tracking.ts's getProgressInfo (Item Detail's own "YOUR TRACKING"
 * section, Dashboard's Continue card body) — duplicating it into the
 * button label itself would just repeat the same text twice on the page.
 */
export function getContinueActionLabel(item: LibraryItem): string {
  if (item.type === "website") return "Open website";
  if (!isMediaItem(item)) return "Open item";

  const verb = CONTINUE_VERB[item.type];
  switch (item.status) {
    case "planned":
      return `Start ${verb}`;
    case "in_progress":
      return `Continue ${verb}`;
    case "on_hold":
      return `Resume ${verb}`;
    case "completed":
    case "dropped":
      // Stage 41 §21/§23 — never claim "Continue"/"Resume" for a
      // finished or abandoned item; still offer the source itself,
      // exactly as a completed/dropped LibraryItem's Source Hub already
      // does further down the same page.
      return "Open source";
  }
}

// ============================================================
// The full ResumeTarget — Stage 41's discriminated result model.
// ============================================================

export interface ResumeSourceOption {
  sourceId: string;
  url: string;
  label: string;
  hostname: string | null;
  progressText: string;
}

export type ResumeTarget =
  | {
      kind: "direct";
      url: string;
      actionLabel: string;
      /** Only ever set for a target resolved from a TrackingSource — there's no adapter identity behind a LibraryItem's own stored url/sourceUrl to name (see "canonical_url" below). */
      sourceLabel?: string;
      hostname?: string;
    }
  | { kind: "choose_source"; actionLabel: string; sources: ResumeSourceOption[] }
  | {
      kind: "canonical_url";
      url: string;
      actionLabel: string;
      hostname?: string;
    }
  | { kind: "unavailable"; reason: "no-target" };

function toResumeSourceOption(source: TrackingSourceSummary): ResumeSourceOption {
  const url = getSafeOpenSourceUrl(source)!; // only ever called on sources selectContinueSource already confirmed have a safe url
  return {
    sourceId: source.id,
    url,
    label: getSourceDisplayName(source.adapterId, source.sourceUrl, source.sourceTitle),
    hostname: getSourceHostname(url),
    progressText: formatSourceProgress(source.lastDetectedProgress),
  };
}

/** The LibraryItem's own stored link — item.url for a Website (always present), item.sourceUrl for a MediaItem (optional, user-entered "where you found this or track this"). catalogSource is deliberately never consulted here — it has no url field at all (Stage 41 §43), so it structurally cannot leak in even by accident. */
function ownStoredUrl(item: LibraryItem): string | undefined {
  if (item.type === "website") return item.url;
  if (isMediaItem(item)) return item.sourceUrl;
  return undefined;
}

/**
 * The one place ANY surface ever decides where Continue/Resume/Open
 * navigates. Priority, unchanged in spirit from the pre-Stage-41 version
 * (lib/dashboard.ts's own resolveResumeTarget) but now source-selection
 * aware of the manual-vs-detected recency distinction above:
 *   1. A single eligible TrackingSource, or several whose recency is
 *      genuinely comparable (selectContinueSource, "direct") — real
 *      consumption history, never catalog metadata.
 *   2. Several eligible TrackingSources whose recency is NOT safely
 *      comparable ("choose_source") — never silently guess; the caller
 *      must offer a chooser.
 *   3. The LibraryItem's own stored URL (website's `url`, or a media
 *      item's own `sourceUrl`), only if it passes the same isValidUrl
 *      check every external target must pass ("canonical_url").
 *   4. Nothing ("unavailable") — the caller decides what (if anything) to
 *      show; this engine never fabricates an internal fallback link
 *      itself, since "is there always a View Details link somewhere on
 *      this card/page" is a presentation decision, not a resume one.
 * Never invents a URL — no /chapter/{progress} synthesis, no provider URL
 * built from catalogSource (which has no url field to build from anyway).
 */
export function resolveResumeTarget(item: LibraryItem, trackingSources: readonly TrackingSourceSummary[]): ResumeTarget {
  if (item.type === "website") {
    const stored = ownStoredUrl(item);
    if (stored && isValidUrl(stored)) {
      return { kind: "canonical_url", url: stored, actionLabel: "Open website", hostname: getSourceHostname(stored) ?? undefined };
    }
    return { kind: "unavailable", reason: "no-target" };
  }

  if (!isMediaItem(item)) return { kind: "unavailable", reason: "no-target" };

  const actionLabel = getContinueActionLabel(item);
  const selection = selectContinueSource(trackingSources, item.id);

  if (selection.kind === "direct") {
    const { source, url } = selection;
    return {
      kind: "direct",
      url,
      actionLabel,
      // Derived from `url` itself (the URL that will actually open), not
      // source.sourceUrl — so the displayed name/host can never disagree
      // with the href, even in principle.
      sourceLabel: getSourceDisplayName(source.adapterId, url, source.sourceTitle),
      hostname: getSourceHostname(url) ?? undefined,
    };
  }

  if (selection.kind === "choose_source") {
    return { kind: "choose_source", actionLabel, sources: selection.sources.map(toResumeSourceOption) };
  }

  const stored = ownStoredUrl(item);
  if (stored && isValidUrl(stored)) {
    return { kind: "canonical_url", url: stored, actionLabel, hostname: getSourceHostname(stored) ?? undefined };
  }

  return { kind: "unavailable", reason: "no-target" };
}

/** Re-exported so callers that only need "is this the item's fallback page" don't need a second import for something this trivial. */
export { getItemHref };
