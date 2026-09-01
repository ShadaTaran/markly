/**
 * AniList currently: uses OAuth2 Authorization Code Grant, has no scopes
 * (a granted token has broad account access — Markly voluntarily limits
 * itself to identity/list reads, see sync.ts), issues long-lived
 * (~1 year) access tokens with NO refresh token, and documents a degraded
 * rate limit of ~30 req/min (normal 90/min). All of this shapes the
 * design here — see anilist/client.ts for rate-limit handling.
 */
export const ANILIST_AUTHORIZE_URL = "https://anilist.co/api/v2/oauth/authorize";
export const ANILIST_TOKEN_URL = "https://anilist.co/api/v2/oauth/token";
export const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";

export const OAUTH_STATE_COOKIE = "markly_anilist_oauth_state";
/** Long enough for a human to complete the AniList consent screen, short enough not to linger as a stale cookie. */
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export function getAniListEnv(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.ANILIST_CLIENT_ID;
  const clientSecret = process.env.ANILIST_CLIENT_SECRET;
  const redirectUri = process.env.ANILIST_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}
