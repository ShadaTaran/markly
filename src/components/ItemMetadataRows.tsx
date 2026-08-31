import type { MetadataRow } from "@/lib/item-detail";

interface ItemMetadataRowsProps {
  rows: MetadataRow[];
}

/** Renders only the rows that exist — omitted metadata is simply not passed in. */
export function ItemMetadataRows({ rows }: ItemMetadataRowsProps) {
  if (rows.length === 0) return null;

  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{row.label}</dt>
          <dd className="break-words text-sm font-medium text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
