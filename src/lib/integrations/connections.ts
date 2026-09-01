import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret, decryptSecret } from "@/lib/integrations/crypto";
import type { ConnectionProvider, ExternalConnectionRow } from "@/lib/integrations/types";

const TABLE = "external_connections";

/** Never call from client code — reads/writes token_ciphertext via a server-side Supabase client. */
export async function getConnection(
  supabase: SupabaseClient,
  userId: string,
  provider: ConnectionProvider,
): Promise<ExternalConnectionRow | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("provider", provider)
    .returns<ExternalConnectionRow[]>();

  if (error) throw error;
  return data?.[0] ?? null;
}

/** Decrypts a connection's token. Throws if the ciphertext is malformed — callers should treat that as reconnect-required, not crash the request. */
export function getConnectionToken(row: ExternalConnectionRow): string {
  return decryptSecret(row.token_ciphertext);
}

export interface SaveConnectionInput {
  providerUserId: string;
  providerUsername: string;
  accessToken: string;
  /** Absolute expiry derived from the token response's actual expires_in — never a hardcoded assumption. Null when the provider gave no expiry. */
  expiresAt: string | null;
}

/** Creates or replaces the connection for (userId, provider) — one user can only ever have one row per provider (unique constraint), so reconnecting cleanly replaces the old token rather than accumulating rows. */
export async function saveConnection(
  supabase: SupabaseClient,
  userId: string,
  provider: ConnectionProvider,
  input: SaveConnectionInput,
): Promise<void> {
  const { error } = await supabase.from(TABLE).upsert(
    {
      user_id: userId,
      provider,
      provider_user_id: input.providerUserId,
      provider_username: input.providerUsername,
      token_ciphertext: encryptSecret(input.accessToken),
      token_expires_at: input.expiresAt,
      connection_status: "connected",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
  if (error) throw error;
}

export async function markReconnectRequired(supabase: SupabaseClient, userId: string, provider: ConnectionProvider): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ connection_status: "reconnect_required", updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw error;
}

export async function updateLastSyncedAt(supabase: SupabaseClient, userId: string, provider: ConnectionProvider, timestamp: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ last_synced_at: timestamp, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw error;
}

export async function deleteConnection(supabase: SupabaseClient, userId: string, provider: ConnectionProvider): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq("user_id", userId).eq("provider", provider);
  if (error) throw error;
}

/** True when the stored expiry has already passed — checked before every authenticated AniList request so an expired token never gets a chance to look like a real request failure. */
export function isConnectionExpired(row: ExternalConnectionRow): boolean {
  if (!row.token_expires_at) return false;
  return new Date(row.token_expires_at).getTime() <= Date.now();
}
