import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountMenu } from "@/components/AccountMenu";
import { ArrowLeftIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

const SETTINGS_NAV = [
  { id: "connections", label: "Connections", href: "/settings/connections" },
  { id: "tracking", label: "Auto Tracking", href: "/settings/tracking" },
  { id: "recovery", label: "Recently Changed", href: "/settings/recovery" },
] as const;

interface SettingsShellProps {
  active: (typeof SETTINGS_NAV)[number]["id"];
  title: string;
  children: React.ReactNode;
}

export function SettingsShell({ active, title, children }: SettingsShellProps) {
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
        <h1 className="mb-4 text-lg font-semibold text-foreground">{title}</h1>
        <nav aria-label="Settings" className="mb-6 flex items-center gap-4 border-b border-border">
          {SETTINGS_NAV.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
              className={cn(
                "border-b-2 pb-2.5 text-sm font-medium transition-colors",
                active === item.id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {children}
      </main>
    </div>
  );
}
