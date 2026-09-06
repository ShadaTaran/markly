import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAniListSession } from "@/lib/integrations/anilist/session";
import { buildWritebackPreview } from "@/lib/integrations/anilist/writeback";
import { AniListAuthError, AniListRateLimitError } from "@/lib/integrations/anilist/client";
import { markReconnectRequired, getAllowAniListWrites } from "@/lib/integrations/connections";

/**
 * Stage 30 — "Sync Now" reconciliation preview. Read-only: fetches
 * current AniList state and compares it against Markly, but never
 * writes to library_items, never touches anilistSync, never calls
 * SaveMediaListEntry — see buildWritebackPreview's own doc comment
 * (§55, regression-tested in scripts/verify-anilist-writeback.mjs).
 */
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
    const preview = await buildWritebackPreview(
      supabase,
      userData.user.id,
      session.accessToken,
      session.anilistUserId,
      getAllowAniListWrites(session.connection),
    );
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof AniListAuthError) {
      await markReconnectRequired(supabase, userData.user.id, "anilist").catch(() => undefined);
      return NextResponse.json({ error: "reconnect_required" }, { status: 409 });
    }
    if (error instanceof AniListRateLimitError) {
      return NextResponse.json({ error: "rate_limited", retryAfterSeconds: error.retryAfterSeconds }, { status: 429 });
    }
    return NextResponse.json({ error: "preview_failed" }, { status: 502 });
  }
}
