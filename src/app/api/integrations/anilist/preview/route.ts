import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAniListSession } from "@/lib/integrations/anilist/session";
import { previewAniListLibrary } from "@/lib/integrations/anilist/sync";
import { AniListAuthError, AniListRateLimitError } from "@/lib/integrations/anilist/client";
import { markReconnectRequired } from "@/lib/integrations/connections";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const session = await loadAniListSession(supabase, userData.user.id);
  if (!session.ok) {
    const status = session.reason === "not_connected" ? 404 : 409;
    return NextResponse.json({ error: session.reason }, { status });
  }

  try {
    const counts = await previewAniListLibrary(session.accessToken, session.anilistUserId);
    return NextResponse.json({ username: session.connection.provider_username, ...counts });
  } catch (error) {
    if (error instanceof AniListAuthError) {
      await markReconnectRequired(supabase, userData.user.id, "anilist").catch(() => undefined);
      return NextResponse.json({ error: "reconnect_required" }, { status: 409 });
    }
    if (error instanceof AniListRateLimitError) {
      return NextResponse.json({ error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds }, { status: 429 });
    }
    return NextResponse.json({ error: "anilist_unavailable" }, { status: 502 });
  }
}
