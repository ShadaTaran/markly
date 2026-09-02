import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SERVER-ONLY. Full-access Supabase client using the project's Secret API
 * Key — it bypasses Row Level Security entirely. The `server-only` import
 * above makes any accidental import of this module from a Client Component
 * a BUILD ERROR, not a silent leak.
 *
 * This exists for exactly one reason: the browser extension authenticates
 * with a device token, not a Supabase session, so there is no `auth.uid()`
 * for RLS to check against. Every call site that uses this client MUST
 * have already independently verified a device token (see
 * lib/extension/devices.ts) or a pairing code (lib/extension/pairing.ts)
 * and MUST manually scope every query to the user_id that verification
 * produced — this client enforces nothing on its own. Never pass a
 * client-supplied user_id to a query made with this client.
 *
 * Used by exactly two routes: /api/extension/pair and
 * /api/extension/progress. Every other Markly route continues to use the
 * session-based client in lib/supabase/server.ts, which still enforces
 * RLS normally.
 *
 * SUPABASE_SECRET_KEY is the current, recommended credential (Supabase's
 * Secret API Key, replacing the legacy service_role JWT). SUPABASE_SERVICE_ROLE_KEY
 * is read only as a fallback for projects still issuing the legacy key —
 * new setups should configure SUPABASE_SECRET_KEY instead (see
 * .env.example and README.md "Auto Tracking").
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secretKey) return null;

  return createSupabaseClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
