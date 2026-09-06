import type { FilterChip } from "@/lib/smart-views";
import { XIcon } from "@/components/icons";

interface FilterChipsProps {
  chips: FilterChip[];
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

/** Compact removable chips for active filters — never a giant filter summary (Stage 31 §38). */
export function FilterChips({ chips, onRemove, onClearAll }: FilterChipsProps) {
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={() => onRemove(chip.id)}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/40"
        >
          {chip.label}
          <XIcon width={12} height={12} />
        </button>
      ))}
      <button type="button" onClick={onClearAll} className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
        Clear all
      </button>
    </div>
  );
}
