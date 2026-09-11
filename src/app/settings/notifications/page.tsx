import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SettingsShell } from "@/components/SettingsShell";
import { NotificationsSettingsPanel } from "@/components/NotificationsSettingsPanel";

/**
 * Stage 37 — push notifications require a signed-in (cloud) account: the
 * delivery engine can only ever see reminders that live in Supabase (a
 * signed-out user's reminders are localStorage-only — see
 * hooks/useReminders.ts). Gated the same way Connections/Auto Tracking
 * already are, rather than showing an Enable button that could never
 * actually do anything useful for a local-only user.
 */
export default async function NotificationsPage() {
  const supabase = await createClient();
  if (!supabase) {
    return (
      <SettingsShell active="notifications" title="Notifications">
        <p className="text-sm text-muted-foreground">Sign in to enable browser notifications.</p>
      </SettingsShell>
    );
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return (
      <SettingsShell active="notifications" title="Notifications">
        <p className="mb-4 text-sm text-muted-foreground">Sign in to enable browser notifications.</p>
        <Link
          href="/login?next=%2Fsettings%2Fnotifications"
          className="inline-block rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
        >
          Sign In
        </Link>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell active="notifications" title="Notifications">
      <NotificationsSettingsPanel />
    </SettingsShell>
  );
}
