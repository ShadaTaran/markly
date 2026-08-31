import Link from "next/link";
import { SearchBar } from "@/components/SearchBar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PlusIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

interface HeaderProps {
  active: "dashboard" | "library";
  /** Only the Library view searches/adds items — omit these to get a bare header. */
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  onAddItem?: () => void;
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", href: "/" },
  { id: "library", label: "Library", href: "/library" },
] as const;

export function Header({ active, searchQuery, onSearchQueryChange, onAddItem }: HeaderProps) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-sm font-semibold text-background">
            M
          </span>
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
                  ? "bg-surface-hover text-foreground"
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
          <ThemeToggle />
          {onAddItem && (
            <button
              type="button"
              onClick={onAddItem}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <PlusIcon width={16} height={16} />
              Add Item
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
