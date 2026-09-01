import type { SupabaseClient } from "@supabase/supabase-js";
import { getConnection, getConnectionToken, isConnectionExpired, markReconnectRequired } from "@/lib/integrations/connections";
import type { ExternalConnectionRow } from "@/lib/integrations/types";

export type AniListSessionResult =
  | { ok: true; connection: ExternalConnectionRow; accessToken: string; anilistUserId: number }
  | { ok: false; reason: "not_connected" | "reconnect_required" };

/**
 * Shared preflight for every AniList route below the OAuth callback:
 * loads the connection, treats an expired or already-flagged token as
 * reconnect-required up front (never sending a known-expired token), and
 * decrypts the token only for the duration of this call — it's never
 * returned to a client.
 */
export async function loadAniListSession(supabase: SupabaseClient, userId: string): Promise<AniListSessionResult> {
  const connection = await getConnection(supabase, userId, "anilist");
  if (!connection) return { ok: false, reason: "not_connected" };

  if (connection.connection_status === "reconnect_required" || isConnectionExpired(connection)) {
    if (connection.connection_status !== "reconnect_required") {
      await markReconnectRequired(supabase, userId, "anilist").catch(() => undefined);
    }
    return { ok: false, reason: "reconnect_required" };
  }

  let accessToken: string;
  try {
    accessToken = getConnectionToken(connection);
  } catch {
    await markReconnectRequired(supabase, userId, "anilist").catch(() => undefined);
    return { ok: false, reason: "reconnect_required" };
  }

  return { ok: true, connection, accessToken, anilistUserId: Number(connection.provider_user_id) };
}
