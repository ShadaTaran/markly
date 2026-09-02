import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generatePairingCode, hashSecret, normalizePairingCodeInput } from "@/lib/extension/tokens";

const TABLE = "pairing_codes";
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** Session-authenticated (RLS-scoped) — called from the signed-in web app's Auto Tracking settings page. */
export async function createPairingCode(supabase: SupabaseClient, userId: string): Promise<{ code: string; expiresAt: string }> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();

  const { error } = await supabase.from(TABLE).insert({
    user_id: userId,
    // Hash the normalized form, matching consumePairingCode below — the
    // raw `code` still carries its display hyphens, and hashing it
    // as-is here would never match a user retyping the code without them.
    code_hash: hashSecret(normalizePairingCodeInput(code)),
    expires_at: expiresAt,
  });
  if (error) throw error;

  return { code, expiresAt };
}

/**
 * Admin-client only — called from /api/extension/pair. A single atomic
 * UPDATE ... WHERE used_at IS NULL AND expires_at > now() (expressed via
 * the query builder below) makes this safe against two near-simultaneous
 * redemption attempts: at most one can ever flip used_at from null, so a
 * code is consumed exactly once regardless of timing.
 */
export async function consumePairingCode(admin: SupabaseClient, rawCode: string): Promise<{ userId: string } | null> {
  const codeHash = hashSecret(normalizePairingCodeInput(rawCode));
  const nowIso = new Date().toISOString();

  const { data, error } = await admin
    .from(TABLE)
    .update({ used_at: nowIso })
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("user_id")
    .returns<{ user_id: string }[]>();
  if (error) throw error;

  const row = data?.[0];
  return row ? { userId: row.user_id } : null;
}
