/** Providers Markly can connect to. Only "anilist" is implemented in Stage 17; this union exists so a future provider slots in without reshaping the table. */
export type ConnectionProvider = "anilist";

export type ConnectionStatus = "connected" | "reconnect_required";

/** Raw external_connections row shape. token_ciphertext must never leave lib/integrations/* — every consumer outside it should use ConnectionSummary instead. */
export interface ExternalConnectionRow {
  id: string;
  user_id: string;
  provider: ConnectionProvider;
  provider_user_id: string;
  provider_username: string;
  token_ciphertext: string;
  token_expires_at: string | null;
  connection_status: ConnectionStatus;
  last_synced_at: string | null;
  provider_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** What's safe to hand to the browser: identity and sync state, never token material. */
export interface ConnectionSummary {
  connected: boolean;
  provider: ConnectionProvider;
  username: string | null;
  lastSyncedAt: string | null;
  reconnectRequired: boolean;
}

export function toConnectionSummary(row: ExternalConnectionRow | null, provider: ConnectionProvider): ConnectionSummary {
  if (!row) {
    return { connected: false, provider, username: null, lastSyncedAt: null, reconnectRequired: false };
  }
  return {
    connected: true,
    provider,
    username: row.provider_username,
    lastSyncedAt: row.last_synced_at,
    reconnectRequired: row.connection_status === "reconnect_required",
  };
}

export interface SyncCounts {
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

/** One item where AniList and Markly have both changed since the last known-good sync baseline — surfaced to the user rather than auto-resolved. */
export interface SyncConflict {
  itemId: string;
  title: string;
  field: "status" | "progress" | "rating";
  markly: { label: string; value: string };
  anilist: { label: string; value: string; mediaId: string; status: string; progress: number; score: number | null; updatedAt: number | null };
}

export interface SyncResult extends SyncCounts {
  conflicts: SyncConflict[];
}
