import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateDeviceToken, hashSecret } from "@/lib/extension/tokens";

const TABLE = "extension_devices";

export interface ExtensionDeviceRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  browser: string | null;
  extension_version: string | null;
  auto_add_enabled: boolean;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/** What's safe to show in Settings — never token_hash. */
export interface DeviceSummary {
  id: string;
  name: string;
  browser: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  /** Stage 22 — see setAutoAddEnabled and README "Optional Zero-Touch Auto-Add". Default false; opt-in per device. */
  autoAddEnabled: boolean;
}

function toSummary(row: ExtensionDeviceRow): DeviceSummary {
  return {
    id: row.id,
    name: row.name,
    browser: row.browser,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revoked: row.revoked_at !== null,
    autoAddEnabled: row.auto_add_enabled,
  };
}

/** Session-authenticated (RLS-scoped) — for the Auto Tracking settings page. */
export async function listDevices(supabase: SupabaseClient, userId: string): Promise<DeviceSummary[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .returns<ExtensionDeviceRow[]>();
  if (error) throw error;
  return (data ?? []).map(toSummary);
}

/** Session-authenticated (RLS-scoped) — revoking never touches library data, only this row. */
export async function revokeDevice(supabase: SupabaseClient, userId: string, deviceId: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", deviceId)
    .eq("user_id", userId);
  if (error) throw error;
}

/**
 * Admin-client only — called from /api/extension/pair after a pairing
 * code has already been independently verified for `userId`. Returns the
 * raw token exactly once; only its hash is ever persisted.
 */
export async function createDevice(
  admin: SupabaseClient,
  userId: string,
  info: { name?: string; browser?: string; extensionVersion?: string },
): Promise<{ id: string; rawToken: string }> {
  const rawToken = generateDeviceToken();
  const { data, error } = await admin
    .from(TABLE)
    .insert({
      user_id: userId,
      name: info.name?.trim() || "Browser Extension",
      token_hash: hashSecret(rawToken),
      browser: info.browser ?? null,
      extension_version: info.extensionVersion ?? null,
    })
    .select("id")
    .returns<{ id: string }[]>();
  if (error) throw error;
  const id = data?.[0]?.id;
  if (!id) throw new Error("Failed to create extension device.");
  return { id, rawToken };
}

export interface AuthenticatedDevice {
  deviceId: string;
  userId: string;
  /** Stage 22 — read in the same lookup so the eligibility check in /api/extension/progress needs no second query. Revoking a device (which already fails this lookup entirely) is therefore also how auto-add naturally stops for it — no parallel auth path. */
  autoAddEnabled: boolean;
}

/**
 * Admin-client only. Hashes the presented raw token and looks it up —
 * the raw token itself is never stored, so this is the only way to
 * resolve one back to a device/user. Returns null for an unknown or
 * revoked token; callers must treat that as "unauthorized," not retry.
 */
export async function authenticateDevice(admin: SupabaseClient, rawToken: string): Promise<AuthenticatedDevice | null> {
  const tokenHash = hashSecret(rawToken);
  const { data, error } = await admin
    .from(TABLE)
    .select("id, user_id, revoked_at, auto_add_enabled")
    .eq("token_hash", tokenHash)
    .returns<{ id: string; user_id: string; revoked_at: string | null; auto_add_enabled: boolean }[]>();
  if (error) throw error;

  const row = data?.[0];
  if (!row || row.revoked_at !== null) return null;

  await admin.from(TABLE).update({ last_seen_at: new Date().toISOString() }).eq("id", row.id);

  return { deviceId: row.id, userId: row.user_id, autoAddEnabled: row.auto_add_enabled };
}

/** Session-authenticated (RLS-scoped) — the one setting Stage 22 exposes; device-level, opt-in, default off (see the migration's own reasoning for why device- not account-level). */
export async function setAutoAddEnabled(supabase: SupabaseClient, userId: string, deviceId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from(TABLE).update({ auto_add_enabled: enabled }).eq("id", deviceId).eq("user_id", userId);
  if (error) throw error;
}
