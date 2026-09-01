import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAniListSession } from "@/lib/integrations/anilist/session";
import { runAniListSync } from "@/lib/integrations/anilist/sync";
import { AniListAuthError, AniListRateLimitError } from "@/lib/integrations/anilist/client";
import { markReconnectRequired, updateLastSyncedAt } from "@/lib/integrations/connections";

interface ImportRequestBody {
  importAnime?: boolean;
  importManga?: boolean;
}

/**
 * First-time (and repeatable) import — safe to call more than once: every
 * write is an upsert keyed by AniList media id, so re-running never
 * duplicates a library item. recordActivity is always false here: a bulk
 * import represents pre-existing AniList state, not actions taken in
 * Markly today, so it must never flood Recent Activity — see
 * RunSyncOptions.recordActivity for the full reasoning. "Sync Now"
 * (sync/route.ts) is the only place AniList-sourced activity ever comes
 * from.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const session = await loadAniListSession(supabase, userData.user.id);
  if (!session.ok) {
    const status = session.reason === "not_connected" ? 404 : 409;
    return NextResponse.json({ error: session.reason }, { status });
  }

  let body: ImportRequestBody;
  try {
    body = (await request.json()) as ImportRequestBody;
  } catch {
    body = {};
  }
  const includeAnime = body.importAnime !== false;
  const includeManga = body.importManga !== false;

  try {
    const result = await runAniListSync(supabase, userData.user.id, session.accessToken, session.anilistUserId, {
      includeAnime,
      includeManga,
      recordActivity: false,
    });
    // Only advance last_synced_at once a run actually completed —
    // never on a failed attempt, so a broken sync doesn't hide behind a
    // fresh-looking timestamp.
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
    return NextResponse.json({ error: "import_failed" }, { status: 502 });
  }
}
