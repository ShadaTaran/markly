import { cn } from "@/lib/utils";
import type { CategoryOption } from "@/lib/bookmarks";

interface CategoryFilterProps {
  categories: CategoryOption[];
  activeCategory: string;
  onChange: (categoryId: string) => void;
}

export function CategoryFilter({
  categories,
  activeCategory,
  onChange,
}: CategoryFilterProps) {
  return (
    <nav
      aria-label="Filter bookmarks by category"
      className="no-scrollbar flex items-center gap-5 overflow-x-auto border-b border-border"
    >
      {categories.map((category) => {
        const isActive = category.id === activeCategory;
        return (
          <button
            key={category.id}
            type="button"
            onClick={() => onChange(category.id)}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:text-foreground",
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {category.label}
            <span className="text-xs text-muted-foreground/80">
              {category.count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
