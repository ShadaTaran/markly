import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { restoreTrackingSource } from "@/lib/extension/tracking-sources";
import { isValidUrl } from "@/lib/website";
import { MAX_TRACKING_SOURCES } from "@/lib/backup/limits";

interface RestoreSourceInput {
  libraryItemId?: string;
  adapterId?: string;
  sourceKey?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  autoTrackEnabled?: boolean;
  suppressed?: boolean;
}

interface RestoreSourcesBody {
  sources?: RestoreSourceInput[];
}

/**
 * Stage 40 data-integrity correction — Part A (backup restore, cloud mode
 * only). Called by BackupSettingsPanel as a separate step AFTER the main
 * `import_library_backup` RPC has already committed items/collections/
 * activity — see restoreTrackingSource's own doc comment for why this is
 * a distinct, non-atomic follow-up rather than something folded into that
 * RPC (doing so would require extending the RPC's return shape, a
 * migration change out of scope for this correction — see the Stage 40
 * final report). A partial failure here never touches the already-
 * committed import; each source is independently resolved.
 *
 * Every field is re-validated here exactly as strictly as the live Add
 * Source route validates its own input (Stage 40 §12) — this body comes
 * from a backup FILE the user chose to upload, which is just as untrusted
 * as any other client input, not merely "data Markly itself just wrote."
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: RestoreSourcesBody;
  try {
    body = (await request.json()) as RestoreSourcesBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (!Array.isArray(body.sources) || body.sources.length > MAX_TRACKING_SOURCES) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let created = 0;
  let linked = 0;
  let alreadyLinked = 0;
  let conflicts = 0;
  let suppressedElsewhere = 0;
  let skippedInvalid = 0;

  for (const entry of body.sources) {
    if (
      !entry ||
      typeof entry.libraryItemId !== "string" ||
      typeof entry.adapterId !== "string" ||
      !entry.adapterId ||
      typeof entry.sourceKey !== "string" ||
      !entry.sourceKey ||
      typeof entry.sourceTitle !== "string" ||
      !entry.sourceTitle ||
      typeof entry.sourceUrl !== "string" ||
      !isValidUrl(entry.sourceUrl)
    ) {
      skippedInvalid++;
      continue;
    }

    try {
      const result = await restoreTrackingSource(
        supabase,
        userData.user.id,
        entry.libraryItemId,
        entry.adapterId,
        entry.sourceKey,
        entry.sourceTitle,
        entry.sourceUrl,
        entry.autoTrackEnabled === true,
        entry.suppressed === true,
      );
      switch (result.status) {
        case "created":
          created++;
          break;
        case "linked":
          linked++;
          break;
        case "already-linked":
          alreadyLinked++;
          break;
        case "conflict":
          conflicts++;
          break;
        case "suppressed-elsewhere":
          suppressedElsewhere++;
          break;
        case "item-not-found":
        case "unsupported-item-type":
          skippedInvalid++;
          break;
      }
    } catch {
      // One source's failure never aborts the rest — matches the
      // established "never roll back what already succeeded" convention
      // (see restoreTrackingSource's own doc comment).
      skippedInvalid++;
    }
  }

  return NextResponse.json({ created, linked, alreadyLinked, conflicts, suppressedElsewhere, skippedInvalid });
}
