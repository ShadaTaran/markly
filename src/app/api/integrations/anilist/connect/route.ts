import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildAuthorizeUrl, generateOAuthState } from "@/lib/integrations/anilist/oauth";
import { getAniListEnv, OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE_SECONDS } from "@/lib/integrations/anilist/constants";

/**
 * Starts the AniList OAuth flow. The browser never sees a client secret or
 * token here — this route only verifies the current Supabase session,
 * mints a one-time state value, and redirects to AniList's own
 * authorization screen.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.redirect(new URL("/settings/connections?anilist_error=not_configured", request.url));
  }

  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    return NextResponse.redirect(new URL("/login?next=%2Fsettings%2Fconnections", request.url));
  }

  if (!getAniListEnv()) {
    return NextResponse.redirect(new URL("/settings/connections?anilist_error=not_configured", request.url));
  }

  const state = generateOAuthState();
  const response = NextResponse.redirect(buildAuthorizeUrl(state));
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/anilist",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return response;
}
