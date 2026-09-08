import { SearchIcon, XIcon } from "@/components/icons";
import { IconButton } from "@/components/IconButton";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    <div className="relative w-full">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search items, tags, or descriptions..."
        aria-label="Search library"
        className="w-full rounded-md border border-border bg-surface py-2 pl-10 pr-10 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25"
      />
      {value && (
        <IconButton
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2"
          icon={<XIcon width={15} height={15} />}
        />
      )}
    </div>
  );
}
