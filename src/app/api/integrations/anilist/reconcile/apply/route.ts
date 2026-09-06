import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadAniListSession } from "@/lib/integrations/anilist/session";
import { applyWritebackItem, type ApplyPlanItem, type ApplyItemResult } from "@/lib/integrations/anilist/writeback";
import { getAllowAniListWrites, markReconnectRequired } from "@/lib/integrations/connections";

interface ApplyRequestBody {
  plan?: ApplyPlanItem[];
}

function isValidPlanItem(value: unknown): value is ApplyPlanItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.itemId !== "string" || typeof v.expectedMediaId !== "string" || typeof v.expectedLocalUpdatedAt !== "string") return false;
  if (typeof v.expectedRemoteExists !== "boolean") return false;
  const changes = v.changes as Record<string, unknown> | undefined;
  if (!changes) return false;
  const validDirection = (d: unknown) => d === "to_anilist" || d === "to_markly" || d === "none";
  return validDirection(changes.progress) && validDirection(changes.status) && validDirection(changes.rating);
}

/**
 * Stage 30 — applies a normalized reconciliation plan, one item at a
 * time (§30: never one giant all-or-nothing operation), sequentially
 * (§31: no concurrent mutation flood). Every item independently
 * re-verifies ownership, local staleness, remote staleness, write
 * eligibility, and the write-preference server-side (§32-§37) — nothing
 * here trusts the client's plan beyond "which item, which direction".
 * Stops early only on rate_limited (respects AniList's own backoff
 * signal — §31); any other per-item failure (not_found,
 * local/remote_changed_since_preview, unsupported_field,
 * remote_read_error/remote_write_error/baseline_save_failed/remote_error)
 * never aborts the rest of the batch (§52) — already-applied items stay
 * applied, never rolled back for a later item's failure (§29, cross-
 * system operations cannot be one ACID transaction).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const session = await loadAniListSession(supabase, userData.user.id);
  if (!session.ok) {
    const status = session.reason === "not_connected" ? 404 : 409;
    return NextResponse.json({ error: session.reason }, { status });
  }

  let body: ApplyRequestBody;
  try {
    body = (await request.json()) as ApplyRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!Array.isArray(body.plan) || body.plan.length === 0 || !body.plan.every(isValidPlanItem)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  // A single reconciliation run is bounded to a sane batch size — the
  // preview itself is one bulk AniList query regardless of library size,
  // but Apply performs one re-fetch + (at most) one mutation per
  // selected item, sequentially; an unbounded client-submitted array
  // could otherwise turn one request into an unbounded serial AniList
  // workload.
  if (body.plan.length > 500) {
    return NextResponse.json({ error: "plan_too_large" }, { status: 413 });
  }

  const allowWrites = getAllowAniListWrites(session.connection);
  const results: ApplyItemResult[] = [];

  for (const item of body.plan) {
    let result: ApplyItemResult;
    try {
      result = await applyWritebackItem(supabase, userData.user.id, session.accessToken, session.anilistUserId, allowWrites, item);
    } catch {
      result = { itemId: item.itemId, status: "remote_error" };
    }
    results.push(result);
    if (result.status === "reconnect_required") {
      await markReconnectRequired(supabase, userData.user.id, "anilist").catch(() => undefined);
      break;
    }
    if (result.status === "rate_limited") {
      break;
    }
  }

  return NextResponse.json({ results, stoppedEarly: results.length < body.plan.length });
}
