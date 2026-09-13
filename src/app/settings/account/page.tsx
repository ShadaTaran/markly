import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SettingsShell } from "@/components/SettingsShell";
import { AccountSettingsPanel } from "@/components/AccountSettingsPanel";

export default async function AccountPage() {
  const supabase = await createClient();
  if (!supabase) {
    return (
      <SettingsShell active="account" title="Account">
        <p className="text-sm text-muted-foreground">Sign in to manage your account.</p>
      </SettingsShell>
    );
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return (
      <SettingsShell active="account" title="Account">
        <p className="mb-4 text-sm text-muted-foreground">Sign in to manage your account.</p>
        <Link
          href="/login?next=%2Fsettings%2Faccount"
          className="inline-block rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
        >
          Sign In
        </Link>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell active="account" title="Account">
      <AccountSettingsPanel email={userData.user.email ?? ""} />
    </SettingsShell>
  );
}
