import crypto from "node:crypto";
import { ANILIST_AUTHORIZE_URL, ANILIST_TOKEN_URL, getAniListEnv } from "@/lib/integrations/anilist/constants";

export function generateOAuthState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** AniList has no scopes to request — omitting `scope` entirely (rather than sending an empty one) matches its current API. */
export function buildAuthorizeUrl(state: string): string {
  const env = getAniListEnv();
  if (!env) throw new Error("AniList is not configured.");

  const url = new URL(ANILIST_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.clientId);
  url.searchParams.set("redirect_uri", env.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
}

export interface ExchangedToken {
  accessToken: string;
  /** Absolute expiry computed from the response's actual expires_in (seconds) — AniList issues no refresh token, so this is the only signal for when reconnection will be needed. */
  expiresAt: string;
}

export async function exchangeCodeForToken(code: string): Promise<ExchangedToken> {
  const env = getAniListEnv();
  if (!env) throw new Error("AniList is not configured.");

  const response = await fetch(ANILIST_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: env.redirectUri,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`AniList token exchange failed (${response.status}).`);
  }

  const json = (await response.json()) as Partial<TokenResponse>;
  if (typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
    throw new Error("AniList token response was malformed.");
  }

  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  return { accessToken: json.access_token, expiresAt };
}
