import { cn } from "@/lib/utils";
import type { CategoryOption } from "@/lib/library-items";

interface FilterTabsProps {
  options: CategoryOption[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

export function FilterTabs({ options, activeId, onChange, ariaLabel }: FilterTabsProps) {
  return (
    <nav
      aria-label={ariaLabel}
      className="no-scrollbar flex items-center gap-5 overflow-x-auto border-b border-border"
    >
      {options.map((option) => {
        const isActive = option.id === activeId;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:text-foreground",
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            <span className="text-xs text-muted-foreground/80">{option.count}</span>
          </button>
        );
      })}
    </nav>
  );
}
