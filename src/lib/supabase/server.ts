import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Server-side Supabase client for Server Components / Route Handlers —
 * reads/writes the session via the request's cookies. Returns null when
 * Supabase isn't configured, matching the client-side helper's fail-soft
 * behavior.
 */
export async function createClient(): Promise<SupabaseClient | null> {
  const env = getSupabaseEnv();
  if (!env) return null;

  const cookieStore = await cookies();

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, which can't set cookies — the
          // middleware below handles session refresh instead, so a stale
          // write attempt here is safe to ignore.
        }
      },
    },
  });
}
