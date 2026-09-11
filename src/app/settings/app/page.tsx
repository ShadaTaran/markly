import { SettingsShell } from "@/components/SettingsShell";
import { AppSettingsPanel } from "@/components/AppSettingsPanel";

/**
 * Stage 38 — unlike Notifications, installing Markly is a browser-level
 * capability, not an account-level one, so this page (like Data & Backup)
 * is never gated behind sign-in.
 */
export default function AppPage() {
  return (
    <SettingsShell active="app" title="App">
      <AppSettingsPanel />
    </SettingsShell>
  );
}
