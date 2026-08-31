import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/supabase/env";

/**
 * Refreshes the Supabase session cookie on every request, per the current
 * recommended Supabase + Next.js App Router session pattern — without this,
 * a session can silently expire between client-side checks. When Supabase
 * isn't configured, this is a no-op: Markly still works entirely in local
 * mode.
 *
 * Named/placed per Next.js 16's `proxy` file convention (the renamed
 * successor to `middleware`, per node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
 */
export async function proxy(request: NextRequest) {
  const env = getSupabaseEnv();
  if (!env) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
