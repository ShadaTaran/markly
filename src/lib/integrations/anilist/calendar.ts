/**
 * Stage 33 — public, unauthenticated AniList airing-schedule fetching.
 *
 * Deliberately separate from client.ts (Stage 17/30's authenticated
 * client, which always attaches a Bearer token and is used for the user's
 * own AniList list) and from lib/metadata/providers/anilist.ts's search
 * (a different query shape). This module exists because upcoming airing
 * data is public AniList metadata, not something tied to the user's
 * account — calling it must never require an AniList connection, a
 * stored access token, or the write-preference toggle, matching the
 * existing precedent already set by lib/metadata/providers/anilist.ts
 * (the same public, CORS-open, no-API-key endpoint, confirmed live: no
 * Authorization header, ~30 req/min unauthenticated rate limit, observed
 * directly via the endpoint's own x-ratelimit-limit response header —
 * not assumed from documentation).
 *
 * Batching (confirmed live against the real public API, not assumed):
 * `Page.airingSchedules(mediaId_in: [...], airingAt_greater, airingAt_lesser)`
 * accepts a bounded array of AniList media ids plus a time-range filter in
 * ONE request — never one request per LibraryItem. `perPage` is
 * server-capped at 50 regardless of what's requested, so a chunk whose
 * total events exceed that needs explicit pagination (see fetchSchedules).
 */

const ANILIST_ENDPOINT = "https://graphql.anilist.co";

/** Media ids per query — comfortably under any request-size concern and matches AniList's own perPage cap, so a single un-paginated response already covers the common case of one page per chunk. */
const CHUNK_SIZE = 50;
/** Hard ceiling on pages fetched per chunk — bounds requests even for one chunk with an unrealistic number of events crammed into one time window. This alone is NOT the scalability guarantee (see MAX_REQUESTS_PER_LOAD below) — it only bounds a single chunk; a library with many chunks could still approach the provider's own budget without it. */
const MAX_PAGES_PER_CHUNK = 5;
/**
 * GLOBAL ceiling on requests for one fetchAniListAiringSchedules call,
 * counted across every chunk and page — never reset per chunk (a
 * correctness-review finding: MAX_PAGES_PER_CHUNK alone bounds one
 * chunk's own pagination, but a library with many distinct AniList ids
 * has many chunks, and nothing previously stopped their combined request
 * count from approaching or exceeding AniList's public unauthenticated
 * budget — confirmed live at exactly 30 requests/minute via this
 * endpoint's own x-ratelimit-limit response header). 20 leaves 10
 * requests of headroom below that budget for anything else happening in
 * the same window (Dashboard mounted alongside Calendar, a metadata
 * search, another tab) — Stage 33 must never knowingly consume the
 * user's entire public quota by itself. Reaching this ceiling — or a
 * single chunk's own MAX_PAGES_PER_CHUNK while AniList still reports
 * more data for it — makes the result explicitly PARTIAL (see
 * FetchSchedulesResult) rather than silently returning fewer events as
 * if that were the complete answer.
 */
const MAX_REQUESTS_PER_LOAD = 20;
const PER_PAGE = 50;

const AIRING_SCHEDULES_QUERY = `
  query ($ids: [Int], $from: Int, $to: Int, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
        mediaId
        episode
        airingAt
        media {
          id
          title { english romaji }
        }
      }
    }
  }
`;

export interface RawAniListAiringSchedule {
  mediaId: unknown;
  episode: unknown;
  airingAt: unknown;
  media?: { id?: unknown; title?: { english?: unknown; romaji?: unknown } } | null;
}

interface AiringSchedulesResponse {
  data?: {
    Page?: {
      pageInfo?: { hasNextPage?: boolean };
      airingSchedules?: RawAniListAiringSchedule[];
    };
  };
  errors?: { message?: string }[];
}

export class AniListCalendarRateLimitError extends Error {
  constructor() {
    super("AniList is rate-limiting schedule requests right now.");
    this.name = "AniListCalendarRateLimitError";
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

async function fetchOnePage(ids: number[], fromEpochSeconds: number, toEpochSeconds: number, page: number, signal: AbortSignal): Promise<{ schedules: RawAniListAiringSchedule[]; hasNextPage: boolean }> {
  const response = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: AIRING_SCHEDULES_QUERY,
      variables: { ids, from: fromEpochSeconds, to: toEpochSeconds, page, perPage: PER_PAGE },
    }),
    signal,
  });

  if (response.status === 429) throw new AniListCalendarRateLimitError();
  if (!response.ok) throw new Error(`AniList request failed (${response.status}).`);

  let json: AiringSchedulesResponse;
  try {
    json = (await response.json()) as AiringSchedulesResponse;
  } catch {
    throw new Error("AniList returned a malformed response.");
  }
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0]?.message ?? "AniList returned an error.");
  }

  return {
    schedules: json.data?.Page?.airingSchedules ?? [],
    hasNextPage: json.data?.Page?.pageInfo?.hasNextPage ?? false,
  };
}

/** Why a schedule fetch stopped before every chunk/page was retrieved — distinct from an outright failure (rate_limited/network_error, thrown as an exception): this is a SUCCESSFUL fetch that is honestly incomplete. */
export type SchedulePartialReason = "pagination_limit" | "request_budget_exhausted";

export interface FetchSchedulesResult {
  schedules: RawAniListAiringSchedule[];
  /** True whenever ANY chunk or page was skipped — the caller must never present `schedules` as a complete answer when this is true (see useReleaseCalendar/CalendarView). */
  isPartial: boolean;
  partialReason?: SchedulePartialReason;
}

/**
 * Fetches every airing schedule entry for the given AniList anime media
 * ids whose airingAt falls in (fromEpochSeconds, toEpochSeconds] — a
 * generous server-side pre-filter; lib/release-calendar.ts's normalizer
 * re-applies the exact window boundary itself rather than trusting this
 * request's own filter semantics precisely (see its own doc comment).
 * `ids` is deduplicated here defensively even though callers are expected
 * to have already deduplicated (§10) — never issues the same id twice in
 * one chunk.
 *
 * Stops early, marking the result partial rather than throwing, in
 * exactly two cases: (1) a single chunk's own MAX_PAGES_PER_CHUNK is
 * reached while AniList still reports more pages for it, or (2) the
 * GLOBAL MAX_REQUESTS_PER_LOAD budget — tracked across every chunk and
 * page, never reset per chunk — is reached before every chunk could even
 * be started. Also stops (silently, no reason set — the caller already
 * discards an aborted/superseded result entirely via LatestRequestGuard)
 * the instant `signal` is aborted, so a superseded request never keeps
 * issuing network calls after the user has moved on.
 */
export async function fetchAniListAiringSchedules(
  mediaIds: readonly number[],
  fromEpochSeconds: number,
  toEpochSeconds: number,
  signal: AbortSignal,
): Promise<FetchSchedulesResult> {
  const uniqueIds = [...new Set(mediaIds)];
  if (uniqueIds.length === 0) return { schedules: [], isPartial: false };

  const results: RawAniListAiringSchedule[] = [];
  let requestCount = 0;
  let partialReason: SchedulePartialReason | undefined;
  let stopped = false;

  for (const idChunk of chunk(uniqueIds, CHUNK_SIZE)) {
    if (stopped || signal.aborted) break;

    let page = 1;
    while (page <= MAX_PAGES_PER_CHUNK) {
      if (signal.aborted) {
        stopped = true;
        break;
      }
      if (requestCount >= MAX_REQUESTS_PER_LOAD) {
        partialReason = "request_budget_exhausted";
        stopped = true;
        break;
      }

      requestCount += 1;
      const { schedules, hasNextPage } = await fetchOnePage(idChunk, fromEpochSeconds, toEpochSeconds, page, signal);
      results.push(...schedules);

      if (!hasNextPage) break;
      if (page === MAX_PAGES_PER_CHUNK) {
        partialReason = "pagination_limit";
        stopped = true;
        break;
      }
      page += 1;
    }
  }

  return { schedules: results, isPartial: partialReason !== undefined, partialReason };
}
