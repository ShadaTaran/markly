import { ANILIST_GRAPHQL_URL } from "@/lib/integrations/anilist/constants";

export class AniListAuthError extends Error {
  constructor() {
    super("AniList rejected the stored access token.");
    this.name = "AniListAuthError";
  }
}

export class AniListRateLimitError extends Error {
  retryAfterSeconds: number | undefined;
  constructor(retryAfterSeconds: number | undefined) {
    super("AniList is rate-limiting requests right now.");
    this.name = "AniListRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; status?: number }[];
}

/**
 * Authenticated AniList GraphQL request. Every caller should send one
 * request per logical operation (Viewer, or the combined anime+manga
 * MediaListCollection query) rather than one per item — see sync.ts.
 * Surfaces rate-limit and auth failures as typed errors so route handlers
 * can respond usefully instead of retrying blindly.
 */
export async function anilistGraphQL<T>(accessToken: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(ANILIST_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AniListAuthError();
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    throw new AniListRateLimitError(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined);
  }

  if (!response.ok) {
    throw new Error(`AniList request failed (${response.status}).`);
  }

  let json: GraphQLResponse<T>;
  try {
    json = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new Error("AniList returned a malformed response.");
  }

  if (json.errors && json.errors.length > 0) {
    const authError = json.errors.some((entry) => entry.status === 401 || entry.status === 403);
    if (authError) throw new AniListAuthError();
    throw new Error(json.errors[0]?.message ?? "AniList returned an error.");
  }

  if (!json.data) {
    throw new Error("AniList returned no data.");
  }

  return json.data;
}

/**
 * Stage 30 — like anilistGraphQL, but tolerates a body-level GraphQL
 * error accompanied by usable partial `data` (confirmed live: AniList
 * can return both `errors` and `data.<field>: null` in the same
 * response — e.g. a per-field resolution issue on one selection doesn't
 * necessarily mean the whole response is unusable). Only
 * `MEDIA_LIST_ENTRY_QUERY` (fetchSingleAniListEntry, anilist/writeback.ts)
 * uses this: a field genuinely resolving to `null` (no list entry for
 * this media) must be distinguishable from a real failure, and this is
 * the one query where that distinction matters. HTTP-level auth
 * (401/403) and rate-limit (429) failures still throw exactly as before —
 * this only relaxes the body-level `errors` array check, and only when
 * `data` itself is present.
 */
export async function anilistGraphQLTolerant<T>(accessToken: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(ANILIST_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AniListAuthError();
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    throw new AniListRateLimitError(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined);
  }

  if (!response.ok) {
    throw new Error(`AniList request failed (${response.status}).`);
  }

  let json: GraphQLResponse<T>;
  try {
    json = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new Error("AniList returned a malformed response.");
  }

  if (json.data) return json.data;

  if (json.errors && json.errors.length > 0) {
    const authError = json.errors.some((entry) => entry.status === 401 || entry.status === 403);
    if (authError) throw new AniListAuthError();
    throw new Error(json.errors[0]?.message ?? "AniList returned an error.");
  }

  throw new Error("AniList returned no data.");
}
