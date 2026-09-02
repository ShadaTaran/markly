import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { consumePairingCode } from "@/lib/extension/pairing";
import { createDevice } from "@/lib/extension/devices";
import { isRateLimited } from "@/lib/extension/rate-limit";

interface PairRequestBody {
  code?: string;
  browser?: string;
  extensionVersion?: string;
}

/** Best-effort client identifier for rate-limiting only — not used for anything security-critical (see rate-limit.ts for why the pairing code's own entropy is the real defense). */
function getClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Called by the extension popup, not the Markly web app — there is no
 * Supabase session here, only a human-entered pairing code. The code is
 * consumed atomically (see consumePairingCode) and, on success, a fresh
 * device token is minted and returned exactly once. Only its hash is
 * ever stored; this response is the only time the raw token exists
 * outside the extension's own trusted storage.
 */
export async function POST(request: Request) {
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  if (isRateLimited(getClientKey(request))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: PairRequestBody;
  try {
    body = (await request.json()) as PairRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!body.code || typeof body.code !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const consumed = await consumePairingCode(admin, body.code);
    if (!consumed) {
      return NextResponse.json({ error: "invalid_or_expired_code" }, { status: 401 });
    }

    const { rawToken } = await createDevice(admin, consumed.userId, {
      browser: typeof body.browser === "string" ? body.browser.slice(0, 100) : undefined,
      extensionVersion: typeof body.extensionVersion === "string" ? body.extensionVersion.slice(0, 50) : undefined,
    });

    return NextResponse.json({ token: rawToken });
  } catch {
    return NextResponse.json({ error: "pairing_failed" }, { status: 502 });
  }
}
