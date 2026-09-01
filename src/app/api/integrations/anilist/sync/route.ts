import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAniListSession } from "@/lib/integrations/anilist/session";
import { runAniListSync } from "@/lib/integrations/anilist/sync";
import { AniListAuthError, AniListRateLimitError } from "@/lib/integrations/anilist/client";
import { markReconnectRequired, updateLastSyncedAt } from "@/lib/integrations/connections";

/**
 * "Sync Now" — pulls the connected account's current Anime/Manga lists and
 * reconciles them against Markly (AniList → Markly only; see
 * anilist/sync.ts for the conflict model). Always considers both types,
 * since by this point the user has already chosen what to import.
 * recordActivity is true here (unlike import/route.ts): by this point any
 * change found genuinely happened since the last sync, so it's worth
 * showing in Recent Activity.
 */
export async function POST() {
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
    const result = await runAniListSync(supabase, userData.user.id, session.accessToken, session.anilistUserId, {
      includeAnime: true,
      includeManga: true,
      recordActivity: true,
    });
    await updateLastSyncedAt(supabase, userData.user.id, "anilist", new Date().toISOString());
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AniListAuthError) {
      await markReconnectRequired(supabase, userData.user.id, "anilist").catch(() => undefined);
      return NextResponse.json({ error: "reconnect_required" }, { status: 409 });
    }
    if (error instanceof AniListRateLimitError) {
      return NextResponse.json({ error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds }, { status: 429 });
    }
    return NextResponse.json({ error: "sync_failed" }, { status: 502 });
  }
}
