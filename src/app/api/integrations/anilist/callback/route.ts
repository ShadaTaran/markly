import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { exchangeCodeForToken } from "@/lib/integrations/anilist/oauth";
import { anilistGraphQL } from "@/lib/integrations/anilist/client";
import { VIEWER_QUERY, type AniListViewerResponse } from "@/lib/integrations/anilist/queries";
import { saveConnection } from "@/lib/integrations/connections";
import { OAUTH_STATE_COOKIE } from "@/lib/integrations/anilist/constants";

function redirectTo(request: NextRequest, path: string, params?: Record<string, string>): NextResponse {
  const url = new URL(path, request.url);
  if (params) Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = NextResponse.redirect(url);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

/**
 * AniList redirects the browser here after the user approves or denies
 * access. Every failure path redirects back to the Connections page with
 * a sanitized error code — never a raw token, secret, or database detail
 * — and the Markly library is never touched on any error branch.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  if (!supabase) return redirectTo(request, "/settings/connections", { anilist_error: "not_configured" });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return redirectTo(request, "/login", { next: "/settings/connections" });

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return redirectTo(request, "/settings/connections", { anilist_error: "denied" });

  const code = params.get("code");
  const returnedState = params.get("state");
  const cookieState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  // Reject any callback that isn't tied to a state value this server
  // itself issued for this browser — without this, a callback URL alone
  // (with someone else's code) could be replayed against a signed-in
  // victim's session.
  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    return redirectTo(request, "/settings/connections", { anilist_error: "state_mismatch" });
  }

  let token;
  try {
    token = await exchangeCodeForToken(code);
  } catch {
    return redirectTo(request, "/settings/connections", { anilist_error: "token_exchange_failed" });
  }

  let viewer;
  try {
    const data = await anilistGraphQL<AniListViewerResponse>(token.accessToken, VIEWER_QUERY);
    if (!data.Viewer) throw new Error("AniList returned no Viewer.");
    viewer = data.Viewer;
  } catch {
    return redirectTo(request, "/settings/connections", { anilist_error: "viewer_lookup_failed" });
  }

  try {
    await saveConnection(supabase, userData.user.id, "anilist", {
      providerUserId: String(viewer.id),
      providerUsername: viewer.name,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
    });
  } catch {
    return redirectTo(request, "/settings/connections", { anilist_error: "save_failed" });
  }

  return redirectTo(request, "/settings/connections", { anilist: "connected" });
}
