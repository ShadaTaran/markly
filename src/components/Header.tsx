import Link from "next/link";
import { SearchBar } from "@/components/SearchBar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountMenu } from "@/components/AccountMenu";
import { ReminderBell } from "@/components/ReminderBell";
import { PlusIcon } from "@/components/icons";
import { Button } from "@/components/Button";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";

interface HeaderProps {
  active: "dashboard" | "library" | "calendar" | "reminders";
  /** Only the Library view searches/adds items — omit these to get a bare header. */
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  onAddItem?: () => void;
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", href: "/" },
  { id: "library", label: "Library", href: "/library" },
  { id: "calendar", label: "Calendar", href: "/calendar" },
] as const;

export function Header({ active, searchQuery, onSearchQueryChange, onAddItem }: HeaderProps) {
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

        {onSearchQueryChange && (
          <div className="order-3 w-full sm:order-none sm:w-auto sm:max-w-md sm:flex-1">
            <SearchBar value={searchQuery ?? ""} onChange={onSearchQueryChange} />
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
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
