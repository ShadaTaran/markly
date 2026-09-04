import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { listDevices } from "@/lib/extension/devices";
import { listSources } from "@/lib/extension/tracking-sources";
import { SettingsShell } from "@/components/SettingsShell";
import { TrackingSettingsPanel } from "@/components/TrackingSettingsPanel";

export default async function TrackingPage() {
  const supabase = await createClient();
  if (!supabase) {
    return (
      <SettingsShell active="tracking" title="Auto Tracking">
        <p className="text-sm text-muted-foreground">Sign in to connect external services securely.</p>
      </SettingsShell>
    );
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return (
      <SettingsShell active="tracking" title="Auto Tracking">
        <p className="mb-4 text-sm text-muted-foreground">Sign in to connect external services securely.</p>
        <Link
          href="/login?next=%2Fsettings%2Ftracking"
          className="inline-block rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
        >
          Sign In
        </Link>
      </SettingsShell>
    );
  }

  // Fails open to empty lists (e.g. the Stage 18 migration hasn't been
  // applied yet) rather than crashing the page — this is read-only,
  // sanitized status, so failing open here can't leak anything.
  let devices: Awaited<ReturnType<typeof listDevices>> = [];
  let sources: Awaited<ReturnType<typeof listSources>> = [];
  try {
    [devices, sources] = await Promise.all([listDevices(supabase, userData.user.id), listSources(supabase, userData.user.id)]);
  } catch {
    devices = [];
    sources = [];
  }

  return (
    <SettingsShell active="tracking" title="Auto Tracking">
      <TrackingSettingsPanel
        initialDevices={devices}
        initialSources={sources.map((row) => ({
          id: row.id,
          adapterId: row.adapter_id,
          sourceTitle: row.source_title,
          sourceUrl: row.source_url,
          mediaType: row.media_type,
          libraryItemId: row.library_item_id,
          autoTrackEnabled: row.auto_track_enabled,
          // Stage 26 bugfix: `season` was previously dropped here too (see
          // the identical fix in /api/tracking-sources/route.ts) — a
          // seasonal source's progress silently lost its season on this
          // page even though the column always had it.
          lastDetectedProgress: row.last_detected_progress
            ? {
                kind: row.last_detected_progress.kind,
                value: row.last_detected_progress.value,
                season: row.last_detected_progress.season,
                confirmed: row.last_detected_progress.confirmed,
              }
            : null,
          lastDetectedMetadata: row.last_detected_progress?.metadata,
          lastSeenAt: row.last_seen_at,
          autoLinkSuppressed: row.auto_link_suppressed_at !== null,
        }))}
      />
    </SettingsShell>
  );
}
