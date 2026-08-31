"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/supabase/env";

/** Creates a fresh browser Supabase client. Prefer getSupabaseClient() below unless a new instance is specifically needed. */
export function createClient(): SupabaseClient | null {
  const env = getSupabaseEnv();
  if (!env) return null;
  return createBrowserClient(env.url, env.anonKey);
}

let cached: SupabaseClient | null | undefined;

/**
 * Memoized singleton browser client, shared across every hook/component
 * that needs one. Supabase's own guidance is to reuse a single client
 * instance per browser tab rather than constructing one per call site.
 * Returns null when Supabase isn't configured (see getSupabaseEnv) —
 * callers must treat that as "cloud mode unavailable," not throw.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (cached === undefined) {
    cached = createClient();
  }
  return cached;
}
