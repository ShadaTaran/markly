/**
 * Reads the public Supabase config. Both values are safe for client code —
 * the anon key is meant to be public and relies on Row Level Security, not
 * secrecy, to protect data. Never add the service-role key here or anywhere
 * client-reachable.
 *
 * Returns null (rather than throwing) when unset, so the app can fail soft
 * into local-only mode instead of crashing every page when Supabase simply
 * hasn't been configured yet.
 */
export function getSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
