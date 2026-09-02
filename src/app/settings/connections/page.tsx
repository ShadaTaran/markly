import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getConnection } from "@/lib/integrations/connections";
import { toConnectionSummary } from "@/lib/integrations/types";
import { SettingsShell } from "@/components/SettingsShell";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";

interface ConnectionsPageProps {
  searchParams: Promise<{ anilist?: string; anilist_error?: string }>;
}

export default async function ConnectionsPage({ searchParams }: ConnectionsPageProps) {
  const params = await searchParams;

  const supabase = await createClient();
  if (!supabase) {
    return (
      <SettingsShell active="connections" title="Connections">
        <p className="text-sm text-muted-foreground">Sign in to connect external services securely.</p>
      </SettingsShell>
    );
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return (
      <SettingsShell active="connections" title="Connections">
        <p className="mb-4 text-sm text-muted-foreground">Sign in to connect external services securely.</p>
        <Link
          href="/login?next=%2Fsettings%2Fconnections"
          className="inline-block rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
        >
          Sign In
        </Link>
      </SettingsShell>
    );
  }

  // Fails open to "not connected" (e.g. the Stage 17 migration hasn't been
  // applied to this database yet) rather than crashing the page — this is
  // read-only, sanitized status, so failing open here can't leak anything.
  let connectionRow = null;
  try {
    connectionRow = await getConnection(supabase, userData.user.id, "anilist");
  } catch {
    connectionRow = null;
  }
  const summary = toConnectionSummary(connectionRow, "anilist");

  return (
    <SettingsShell active="connections" title="Connections">
      <ConnectionsPanel
        initialSummary={summary}
        justConnected={params.anilist === "connected"}
        connectError={params.anilist_error}
      />
    </SettingsShell>
  );
}
