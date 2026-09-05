import { SettingsShell } from "@/components/SettingsShell";
import { BackupSettingsPanel } from "@/components/BackupSettingsPanel";

export default function BackupPage() {
  return (
    <SettingsShell active="backup" title="Data & Backup">
      <BackupSettingsPanel />
    </SettingsShell>
  );
}
