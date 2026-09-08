import type { LibraryViewMode } from "@/hooks/useLibraryViewMode";
import { IconButton } from "@/components/IconButton";
import { GridIcon, CompactGridIcon, ListViewIcon } from "@/components/icons";

const MODES: { id: LibraryViewMode; label: string; icon: typeof GridIcon }[] = [
  { id: "grid", label: "Grid view", icon: GridIcon },
  { id: "compact", label: "Compact view", icon: CompactGridIcon },
  { id: "list", label: "List view", icon: ListViewIcon },
];

interface LibraryViewModeSwitcherProps {
  value: LibraryViewMode;
  onChange: (mode: LibraryViewMode) => void;
}

/** Grid/Compact/List — a UI-only preference (see useLibraryViewMode), never affects which items match or how they're sorted. */
export function LibraryViewModeSwitcher({ value, onChange }: LibraryViewModeSwitcherProps) {
  return (
    <div role="group" aria-label="Library view" className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
      {MODES.map(({ id, label, icon: Icon }) => (
        <IconButton
          key={id}
          onClick={() => onChange(id)}
          aria-pressed={value === id}
          aria-label={label}
          title={label}
          icon={<Icon width={16} height={16} />}
          className={value === id ? "bg-accent/10 text-accent hover:text-accent" : undefined}
        />
      ))}
    </div>
  );
}
