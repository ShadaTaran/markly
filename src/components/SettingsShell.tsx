import Link from "next/link";
import { PageContainer } from "@/components/PageContainer";
import { SecondaryPageHeader } from "@/components/SecondaryPageHeader";
import { cn } from "@/lib/utils";

const SETTINGS_NAV = [
  { id: "connections", label: "Connections", href: "/settings/connections" },
  { id: "tracking", label: "Auto Tracking", href: "/settings/tracking" },
  { id: "notifications", label: "Notifications", href: "/settings/notifications" },
  { id: "recovery", label: "Recently Changed", href: "/settings/recovery" },
  { id: "backup", label: "Data & Backup", href: "/settings/backup" },
] as const;

interface SettingsShellProps {
  active: (typeof SETTINGS_NAV)[number]["id"];
  title: string;
  children: React.ReactNode;
}

export function SettingsShell({ active, title, children }: SettingsShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SecondaryPageHeader maxWidthClassName="max-w-2xl" />
      <PageContainer width="settings" paddingY="py-8">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Settings</p>
        <h1 className="mb-4 text-lg font-semibold text-foreground">{title}</h1>
        {/* Stage 37 — a 5th tab (Notifications) pushed this row past 375px
            (confirmed live: scrollWidth 410 vs. clientWidth 375, real
            horizontal page overflow), something the previous 4-tab row
            never triggered. Fixed with a horizontally-scrollable nav
            (overflow-x-auto + shrink-0/whitespace-nowrap items) rather than
            any visual redesign — a no-op on desktop, where everything still
            fits on one line exactly as before. */}
        <nav aria-label="Settings" className="mb-6 flex items-center gap-4 overflow-x-auto border-b border-border">
          {SETTINGS_NAV.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
              className={cn(
                "shrink-0 whitespace-nowrap border-b-2 pb-2.5 text-sm font-medium transition-colors",
                active === item.id
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {children}
      </PageContainer>
    </div>
  );
}
