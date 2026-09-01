import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getConnection } from "@/lib/integrations/connections";
import { toConnectionSummary } from "@/lib/integrations/types";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountMenu } from "@/components/AccountMenu";
import { ArrowLeftIcon } from "@/components/icons";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";

interface ConnectionsPageProps {
  searchParams: Promise<{ anilist?: string; anilist_error?: string }>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-2xl items-center gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link
            href="/library"
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ArrowLeftIcon width={16} height={16} />
            Back to Library
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <AccountMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="mb-6 text-lg font-semibold text-foreground">Connections</h1>
        {children}
      </main>
    </div>
  );
}

export default async function ConnectionsPage({ searchParams }: ConnectionsPageProps) {
  const params = await searchParams;

  const supabase = await createClient();
  if (!supabase) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Sign in to connect external services securely.</p>
      </Shell>
    );
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return (
      <Shell>
        <p className="mb-4 text-sm text-muted-foreground">Sign in to connect external services securely.</p>
        <Link
          href="/login?next=%2Fsettings%2Fconnections"
          className="inline-block rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
        >
          Sign In
        </Link>
      </Shell>
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
    <Shell>
      <ConnectionsPanel
        initialSummary={summary}
        justConnected={params.anilist === "connected"}
        connectError={params.anilist_error}
      />
    </Shell>
  );
}
