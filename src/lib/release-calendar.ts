import type { LibraryItem } from "@/types/library-item";
import type { ReleaseEvent } from "@/types/release-event";
import type { RawAniListAiringSchedule } from "@/lib/integrations/anilist/calendar";

/**
 * Stage 33 — pure Release Calendar logic. Nothing here performs I/O; the
 * AniList network call lives in lib/integrations/anilist/calendar.ts, and
 * React state lives in hooks/useReleaseCalendar.ts. Kept separate so every
 * rule below (library scoping, dedup, window boundaries, timezone
 * grouping, sorting) is independently unit-testable without a network or
 * a component tree — see scripts/verify-release-calendar.mjs.
 *
 * v1 scope, confirmed in Phase 0 by inspecting the real data model (never
 * assumed): only `type: "anime"` items with `catalogSource.provider ===
 * "anilist"` produce events, via AniList's public airingSchedule data.
 * Manga/novel have no chapter-level schedule in AniList's API at all
 * (confirmed live: querying `airingSchedule`/`nextAiringEpisode` for a
 * MANGA-type media returns empty/null even for an actively-serializing
 * title). Game/Movie/Series have no authoritative release DATE stored
 * anywhere in Markly (only an optional `releaseYear`, far too coarse for
 * a calendar event), and Series is TMDB-sourced, never AniList. None of
 * these get a fabricated event — they simply produce none.
 */

export const CALENDAR_RANGE_OPTIONS = [7, 14, 30] as const;
export type CalendarRangeDays = (typeof CALENDAR_RANGE_OPTIONS)[number];
export const DEFAULT_CALENDAR_RANGE_DAYS: CalendarRangeDays = 14;

// ============================================================
// LibraryItem -> AniList media id association (§5, §10, §80)
// ============================================================

/**
 * Every LibraryItem eligible for an AniList schedule lookup, collapsed to
 * ONE deterministic association per media id. Stage 27 duplicate
 * detection can't prevent two LibraryItems from temporarily sharing the
 * same (provider, externalId) — when that happens, this picks the
 * candidate with the lexicographically smallest `id`, the same
 * "sort ascending, take first" tie-break convention already used
 * elsewhere in this codebase (e.g. lib/dashboard.ts's TrackingSource
 * selection). This never merges or mutates either LibraryItem — it only
 * decides which one a rendered ReleaseEvent points at.
 */
export function buildAniListMediaAssociation(items: readonly LibraryItem[]): Map<number, LibraryItem> {
  const candidatesByMediaId = new Map<number, LibraryItem[]>();
  for (const item of items) {
    if (item.type !== "anime") continue;
    const catalogSource = item.catalogSource;
    if (!catalogSource || catalogSource.provider !== "anilist") continue;
    const mediaId = Number(catalogSource.externalId);
    if (!Number.isInteger(mediaId) || mediaId <= 0) continue;
    const list = candidatesByMediaId.get(mediaId);
    if (list) list.push(item);
    else candidatesByMediaId.set(mediaId, [item]);
  }

  const association = new Map<number, LibraryItem>();
  for (const [mediaId, candidates] of candidatesByMediaId) {
    const chosen = candidates.length === 1 ? candidates[0] : [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0];
    association.set(mediaId, chosen);
  }
  return association;
}

// ============================================================
// Window boundary (§83): startsAt > now, startsAt <= rangeEnd
// ============================================================
export function isWithinReleaseWindow(startsAtMs: number, nowMs: number, rangeEndMs: number): boolean {
  return startsAtMs > nowMs && startsAtMs <= rangeEndMs;
}

// ============================================================
// Normalization (§32): AniList response -> ReleaseEvent[]
// ============================================================

export interface NormalizeWindow {
  nowMs: number;
  rangeEndMs: number;
}

function makeReleaseEventId(mediaId: number, episode: number, startsAt: string): string {
  return `anilist:${mediaId}:${episode}:${startsAt}`;
}

/**
 * Never trusts the AniList request's own airingAt_greater/airingAt_lesser
 * filter to have matched this exact boundary (§83's precise `>`/`<=`
 * semantics aren't necessarily how AniList's own operators behave) — the
 * window check is re-applied here, the one place both this and any future
 * provider's events are held to the same rule. Also the single point that
 * enforces library-only scope (§9/§79): an event for a media id with no
 * association entry is silently discarded, never rendered as if it were
 * global AniList discovery data. Deduplicates by the same stable id used
 * for React identity (§11/§56) — pagination overlap or two chunks
 * returning the same schedule can never produce two rendered events.
 */
export function normalizeAniListSchedules(
  raw: readonly RawAniListAiringSchedule[],
  mediaIdToLibraryItem: ReadonlyMap<number, LibraryItem>,
  window: NormalizeWindow,
): ReleaseEvent[] {
  const seen = new Set<string>();
  const events: ReleaseEvent[] = [];

  for (const entry of raw) {
    const mediaId = typeof entry.mediaId === "number" ? entry.mediaId : Number(entry.mediaId);
    if (!Number.isInteger(mediaId)) continue;

    const libraryItem = mediaIdToLibraryItem.get(mediaId);
    if (!libraryItem) continue;

    const episode = typeof entry.episode === "number" && Number.isFinite(entry.episode) && entry.episode > 0 ? entry.episode : undefined;
    if (episode === undefined) continue;

    const airingAtSeconds = typeof entry.airingAt === "number" && Number.isFinite(entry.airingAt) ? entry.airingAt : undefined;
    if (airingAtSeconds === undefined) continue;
    const startsAtMs = airingAtSeconds * 1000;
    if (!isWithinReleaseWindow(startsAtMs, window.nowMs, window.rangeEndMs)) continue;

    const startsAt = new Date(startsAtMs).toISOString();
    const id = makeReleaseEventId(mediaId, episode, startsAt);
    if (seen.has(id)) continue;
    seen.add(id);

    const rawTitle = entry.media?.title;
    const mediaTitle = typeof rawTitle?.english === "string" ? rawTitle.english : typeof rawTitle?.romaji === "string" ? rawTitle.romaji : undefined;

    events.push({
      id,
      provider: "anilist",
      kind: "episode",
      libraryItemId: libraryItem.id,
      externalMediaId: String(mediaId),
      startsAt,
      episode,
      title: libraryItem.title,
      sourceMetadata: mediaTitle ? { mediaTitle } : undefined,
    });
  }

  return events;
}

// ============================================================
// Sorting (§34)
// ============================================================
export function sortReleaseEvents(events: readonly ReleaseEvent[]): ReleaseEvent[] {
  return [...events].sort((a, b) => {
    if (a.startsAt !== b.startsAt) return a.startsAt.localeCompare(b.startsAt);
    const byTitle = (a.title ?? "").localeCompare(b.title ?? "", undefined, { sensitivity: "base" });
    if (byTitle !== 0) return byTitle;
    return a.id.localeCompare(b.id);
  });
}

// ============================================================
// Timezone-aware local-day grouping (§14-§19, §33, §76-§77)
// ============================================================

/** en-CA formats as YYYY-MM-DD — a reliable, standards-based way to get a sortable local calendar-day key for any IANA zone without manual offset arithmetic (DST included). */
export function getLocalDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Treats a YYYY-MM-DD key as a UTC calendar date purely for day-difference arithmetic — never reinterpreted as a real instant in `timeZone`, so this can't be thrown off by DST. */
function dayKeyToUTCDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export interface ReleaseEventDayGroup {
  dayKey: string;
  events: ReleaseEvent[];
}

/** Input: ReleaseEvent[], timeZone. Output: groups keyed by the event's LOCAL calendar day in that zone, day-ascending, each group's own events sorted by sortReleaseEvents. Deliberately takes no `now` — "Today"/"Tomorrow" labeling is a separate concern (formatReleaseDayLabel) applied at render time, so this stays a pure function of the events themselves. */
export function groupReleaseEventsByLocalDay(events: readonly ReleaseEvent[], timeZone: string): ReleaseEventDayGroup[] {
  const byDay = new Map<string, ReleaseEvent[]>();
  for (const event of events) {
    const dayKey = getLocalDayKey(new Date(event.startsAt), timeZone);
    const list = byDay.get(dayKey);
    if (list) list.push(event);
    else byDay.set(dayKey, [event]);
  }

  return [...byDay.entries()]
    .map(([dayKey, dayEvents]) => ({ dayKey, events: sortReleaseEvents(dayEvents) }))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

/** "Today"/"Tomorrow"/"September 10" — calendar-day semantics in `timeZone`, never `now + 24h` (§17). Compares day-keys as date values, not wall-clock times, so this is immune to DST shifts on the comparison itself. */
export function formatReleaseDayLabel(dayKey: string, timeZone: string, now: Date): string {
  const nowKey = getLocalDayKey(now, timeZone);
  const diffDays = Math.round((dayKeyToUTCDate(dayKey).getTime() - dayKeyToUTCDate(nowKey).getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(dayKeyToUTCDate(dayKey));
}

/** "6:30 PM" in `timeZone` — never a raw Unix timestamp (§18). */
export function formatReleaseEventTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** Full local date+time for a title/tooltip's accessible-text use (§18/§71) — e.g. "September 8, 2026, 1:00 AM". */
export function formatReleaseEventFullDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone }).format(new Date(iso));
}

/** The browser's own IANA zone, read once via the standard Intl API — never inferred from cookies/account data (§66). Shared by CalendarView and DashboardView's Upcoming section so neither guesses independently. */
export function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
