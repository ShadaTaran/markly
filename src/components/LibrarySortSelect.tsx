import type { SmartViewSort } from "@/types/smart-view";

/** Stage 31 §33 — deliberately no "Progress" sort: episode/chapter/percent/playtime are semantically incomparable across media types. */
const SORT_OPTIONS: { key: string; sort: SmartViewSort; label: string }[] = [
  { key: "title-asc", sort: { by: "title", direction: "asc" }, label: "Title" },
  { key: "createdAt-desc", sort: { by: "createdAt", direction: "desc" }, label: "Recently added" },
  { key: "createdAt-asc", sort: { by: "createdAt", direction: "asc" }, label: "Oldest added" },
  { key: "lastActivity-desc", sort: { by: "lastActivity", direction: "desc" }, label: "Recently active" },
  { key: "rating-desc", sort: { by: "rating", direction: "desc" }, label: "Highest rated" },
  { key: "rating-asc", sort: { by: "rating", direction: "asc" }, label: "Lowest rated" },
];

function keyOf(sort: SmartViewSort): string {
  return `${sort.by}-${sort.direction}`;
}

interface LibrarySortSelectProps {
  value: SmartViewSort;
  onChange: (sort: SmartViewSort) => void;
}

export function LibrarySortSelect({ value, onChange }: LibrarySortSelectProps) {
  const currentKey = keyOf(value);

  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="hidden sm:inline">Sort:</span>
      <select
        value={SORT_OPTIONS.some((option) => option.key === currentKey) ? currentKey : "title-asc"}
        onChange={(event) => {
          const option = SORT_OPTIONS.find((candidate) => candidate.key === event.target.value);
          if (option) onChange(option.sort);
        }}
        aria-label="Sort items"
        className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
