import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { authenticateDevice } from "@/lib/extension/devices";
import { getSourceByKey, recordDetection, claimSourceLink, clearBrokenLink } from "@/lib/extension/tracking-sources";
import { attemptSmartAutoLink } from "@/lib/extension/auto-link";
import { attemptAutoAdd } from "@/lib/extension/auto-add";
import { applyDetectionToItem } from "@/lib/extension/progress";
import { parseDetectedMetadata } from "@/lib/extension/detected-metadata";
import { enrichLibraryItemIfSparse } from "@/lib/extension/enrichment";
import { logSanitizedError } from "@/lib/extension/log-error";
import type { MediaItem } from "@/types/library-item";
import type { TrackingSourceSummary } from "@/lib/extension/types";

const TRACKABLE_TYPES: readonly MediaItem["type"][] = ["anime", "manga", "novel", "game", "movie", "series"];

interface ProgressRequestBody {
  adapterId?: string;
  sourceKey?: string;
  sourceUrl?: string | null;
  sourceTitle?: string;
  mediaType?: string;
  progress?: { kind?: string; value?: number };
  detectedMetadata?: unknown;
  /**
   * Stage 24 — false only for a video "episode detected" discovery ping:
   * establishes source identity / Smart Auto-Link / Auto-Add, but never
   * commits the detected value as progress. Any value other than the
   * literal boolean `false` (including absent, or a malformed non-
   * boolean) is treated as `true` — the existing, unchanged behavior
   * every reading-media detection has always relied on.
   */
  commitProgress?: unknown;
}

function isMediaType(value: string | undefined): value is MediaItem["type"] {
  return typeof value === "string" && (TRACKABLE_TYPES as readonly string[]).includes(value);
}

/**
 * The extension's only write path into Markly. Authenticates a device
 * token (never a userId supplied by the request), then submits nothing
 * more than a normalized progress observation — never an arbitrary
 * database patch. See lib/extension/progress.ts for the monotonic
 * (advance-only) update rule and lib/extension/tracking-sources.ts for
 * the persistent source→item mapping this depends on.
 */
export async function POST(request: Request) {
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const device = await authenticateDevice(admin, token).catch(() => null);
  if (!device) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: ProgressRequestBody;
  try {
    body = (await request.json()) as ProgressRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const adapterId = typeof body.adapterId === "string" ? body.adapterId.trim() : "";
  const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey.trim() : "";
  const sourceTitle = typeof body.sourceTitle === "string" ? body.sourceTitle.trim().slice(0, 300) : "";
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.slice(0, 2000) : null;
  const mediaType = body.mediaType;
  const progressKind = typeof body.progress?.kind === "string" ? body.progress.kind : "";
  const progressValue = typeof body.progress?.value === "number" ? body.progress.value : NaN;
  // Never trust the extension's own bounds — re-validated from scratch
  // here regardless of what shape it arrived in. Absent/invalid is not an
  // error; it just means no enrichment happens for this request.
  const detectedMetadata = parseDetectedMetadata(body.detectedMetadata);
  const commitProgress = body.commitProgress !== false;

  if (
    !adapterId ||
    !sourceKey ||
    !sourceTitle ||
    !isMediaType(mediaType) ||
    !progressKind ||
    !Number.isFinite(progressValue) ||
    progressValue < 0
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const existing = await getSourceByKey(admin, device.userId, adapterId, sourceKey);

    const detected = await recordDetection(admin, device.userId, {
      adapterId,
      sourceKey,
      sourceTitle,
      sourceUrl,
      mediaType,
      progress: { kind: progressKind, value: progressValue },
      ...(!commitProgress && { confirmed: false }),
      ...(detectedMetadata && { detectedMetadata }),
    });

    if (existing && !existing.auto_track_enabled) {
      return NextResponse.json({ status: "tracking_disabled" });
    }

    let libraryItemId = existing?.library_item_id ?? null;
    let autoLinked = false;
    let autoAdded = false;

    if (!libraryItemId) {
      // No established mapping yet — either a brand-new source, or one
      // detected before this feature existed (previously stuck at
      // needs_link forever). Try a smart auto-link before falling back to
      // manual linking; never re-attempted once a mapping exists (see
      // lib/extension/auto-link.ts for the matching rules).
      const outcome = await attemptSmartAutoLink(admin, device.userId, mediaType, sourceTitle);
      if (outcome.kind === "matched") {
        // Atomic claim: if a concurrent identical first detection already
        // won this link, this returns *that* id rather than silently
        // trusting our own (deterministically identical, in the ordinary
        // case) candidate — see claimSourceLink.
        libraryItemId = await claimSourceLink(admin, device.userId, detected.id, outcome.libraryItemId);
        autoLinked = true;
      } else if (outcome.kind === "no_match" && device.autoAddEnabled) {
        // Stage 22: exact match still wins (above); ambiguous still never
        // auto-creates (outcome.kind === "ambiguous" falls through to the
        // needs_link response below, same as when auto-add is off). Only
        // a genuine "nothing matches" reaches here, and only when this
        // specific device has opted in.
        const source: TrackingSourceSummary = {
          id: detected.id,
          adapterId,
          sourceTitle,
          sourceUrl,
          mediaType,
          libraryItemId: null,
          autoTrackEnabled: true,
          // confirmed: false here is what stops buildDetectedMediaInput
          // (called inside attemptAutoAdd) from baking an unwatched
          // episode number into the item this creates — see its own doc
          // comment. Harmless/no-op for a chapter-kind detection, which
          // never checks this flag at all.
          lastDetectedProgress: { kind: progressKind, value: progressValue, ...(!commitProgress && { confirmed: false }) },
          ...(detectedMetadata && { lastDetectedMetadata: detectedMetadata }),
          lastSeenAt: new Date().toISOString(),
        };
        const addOutcome = await attemptAutoAdd(admin, device.userId, detected.id, mediaType, source);
        if (addOutcome.kind === "created") {
          libraryItemId = addOutcome.libraryItemId;
          autoAdded = true;
        } else if (addOutcome.kind === "linked_existing" || addOutcome.kind === "already_linked") {
          libraryItemId = addOutcome.libraryItemId;
          autoLinked = addOutcome.kind === "linked_existing";
        }
        // "ambiguous" / "source_not_found" / "invalid_title" all fall
        // through to the needs_link response below, unchanged.
      }

      if (!libraryItemId) {
        return NextResponse.json({ status: "needs_link", reason: outcome.kind === "ambiguous" ? "ambiguous" : "no_match" });
      }
    }

    // Stage 24 — a video "episode detected" discovery ping: identity is
    // established (recordDetection above, plus Smart Auto-Link/Auto-Add
    // just above), but the detected value is deliberately never committed
    // as progress. Enrichment still runs (metadata isn't progress, and is
    // always safe/best-effort regardless); applyDetectionToItem — the one
    // function that actually writes to currentEpisode/currentChapter/etc.
    // and inserts Activity — is skipped entirely. The eventual completion
    // event is just a normal commitProgress-true request through this
    // same route, reusing 100% of the existing monotonic-progress path
    // below unchanged.
    if (!commitProgress) {
      await enrichLibraryItemIfSparse(admin, device.userId, libraryItemId, mediaType, detectedMetadata).catch(() => undefined);
      return NextResponse.json({
        status: "detected",
        ...(autoLinked ? { autoLinked: true } : {}),
        ...(autoAdded ? { autoAdded: true } : {}),
      });
    }

    // The read, the compare, the write, and the Activity insert(s) all
    // happen atomically inside applyDetectionToItem's database RPC — no
    // separate pre-fetch here, since a fetch-then-decide-in-JS step is
    // exactly the race this replaced (see lib/extension/progress.ts).
    const result = await applyDetectionToItem(admin, device.userId, libraryItemId, mediaType, progressKind, progressValue);

    if (result.status === "item_not_found") {
      await clearBrokenLink(admin, detected.id);
      return NextResponse.json({ status: "needs_link", reason: "no_match" });
    }

    // Best-effort, silent, and strictly additive — never allowed to affect
    // the response or fail the request that just successfully recorded a
    // real progress update (errors are swallowed, not surfaced). Awaited
    // rather than fire-and-forget so it actually runs to completion even
    // under a serverless deployment, which can tear down the function as
    // soon as the response is sent and abandon any unawaited work. See
    // enrichment.ts for the "fill empty fields only" merge policy and why
    // this doesn't need atomic RPC treatment the way progress does.
    await enrichLibraryItemIfSparse(admin, device.userId, libraryItemId, mediaType, detectedMetadata).catch(() => undefined);

    return NextResponse.json({
      status: result.status,
      currentValue: result.currentValue,
      ...(autoLinked ? { autoLinked: true } : {}),
      ...(autoAdded ? { autoAdded: true } : {}),
    });
  } catch (err) {
    // Sanitized (code/message/details/hint only — never headers, tokens,
    // or the raw error object) and terminal-only; the HTTP response stays
    // the same generic, unsanitized-nothing "tracking_failed" it always
    // was. See log-error.ts's own doc comment for exactly what is and
    // isn't logged.
    logSanitizedError("[extension:progress] request failed", err);
    return NextResponse.json({ error: "tracking_failed" }, { status: 502 });
  }
}
