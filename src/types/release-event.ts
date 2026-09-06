/**
 * Stage 33 — one normalized, provider-independent shape the Calendar UI
 * consumes. Components never see a raw AniList GraphQL object; only
 * lib/integrations/anilist/calendar.ts and lib/release-calendar.ts's
 * normalizer ever touch that shape (see their own doc comments).
 */
export type ReleaseEventProvider = "anilist";

/** Deliberately narrow for v1 — see lib/release-calendar.ts's doc comment for why manga/novel/game/movie/series have no event kind of their own yet. */
export type ReleaseEventKind = "episode";

export interface ReleaseEvent {
  /** Stable, deterministic — `${provider}:${externalMediaId}:${episode}:${startsAt}` (see lib/release-calendar.ts's makeReleaseEventId). Never an array index. */
  id: string;
  provider: ReleaseEventProvider;
  kind: ReleaseEventKind;
  /** The Markly LibraryItem this event is shown against — always a real, currently-present item (see lib/release-calendar.ts's library-scoping rule). */
  libraryItemId: string;
  /** The provider's own media id, as a string (AniList ids are numeric, but this stays a string so a future non-numeric provider id needs no shape change). */
  externalMediaId: string;
  /** ISO 8601, always UTC (AniList's own airingAt is a unix-epoch instant — see fromAniListAiringSchedule). Never a wall-clock/local string. */
  startsAt: string;
  /** The provider's own schedule-position number (e.g. AniList's absolute episode count for this media) — never converted to or mixed with a Markly item's personal currentEpisode/currentSeason (Stage 25 stays untouched). */
  episode?: number;
  /** The Markly LibraryItem's own title, stamped at normalization time — the UI displays THIS, never sourceMetadata.mediaTitle (§35: Markly's Library stays canonical for presentation, the provider's title is context only). */
  title?: string;
  /** The provider's own title for the media, kept only as context/debugging — never shown as the primary title. */
  sourceMetadata?: {
    mediaTitle?: string;
  };
}
