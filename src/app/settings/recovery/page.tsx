import { SettingsShell } from "@/components/SettingsShell";
import { RecentRecoveryPanel } from "@/components/RecentRecoveryPanel";

export default function RecoveryPage() {
  return (
    <SettingsShell active="recovery" title="Recently Changed">
      <RecentRecoveryPanel />
    </SettingsShell>
  );
}
