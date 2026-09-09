import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountMenu } from "@/components/AccountMenu";
import { ReminderBell } from "@/components/ReminderBell";
import { CommandPaletteTriggerButton } from "@/components/CommandPaletteTriggerButton";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/Button";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";

interface HeaderProps {
  active: "dashboard" | "library" | "calendar" | "reminders";
  /**
   * Only Library shows an "Add Item" button in the Header (opens the
   * canonical LibraryItemDialog). Every page's Header exposes exactly one
   * search affordance — the global Command Palette trigger — never a
   * page-local search field; Library's own filter search lives in its own
   * content toolbar instead (see LibraryView.tsx, Stage 36 consistency
   * pass), so it doesn't compete with the palette for the same slot.
   */
  onAddItem?: () => void;
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", href: "/" },
  { id: "library", label: "Library", href: "/library" },
  { id: "calendar", label: "Calendar", href: "/calendar" },
] as const;

export function Header({ active, onAddItem }: HeaderProps) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex shrink-0 items-center gap-2">
          <Logo />
          <span className="text-lg font-semibold tracking-tight">Markly</span>
        </div>

        <nav aria-label="Primary" className="flex shrink-0 items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                active === item.id
                  ? "bg-accent/10 text-accent"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <CommandPaletteTriggerButton />
          <ReminderBell />
          <ThemeToggle />
          <AccountMenu />
          {onAddItem && (
            <Button variant="primary" onClick={onAddItem}>
              <PlusIcon width={16} height={16} />
              Add Item
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
