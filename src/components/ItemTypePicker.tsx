import { ITEM_TYPE_LABELS, SUPPORTED_ITEM_TYPES, type SupportedItemType } from "@/types/library-item";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";

interface ItemTypePickerProps {
  onSelect: (type: SupportedItemType) => void;
}

export function ItemTypePicker({ onSelect }: ItemTypePickerProps) {
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">What are you adding?</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SUPPORTED_ITEM_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => onSelect(type)}
            className="flex flex-col items-center gap-2 rounded-md border border-border p-3 text-sm font-medium text-foreground transition-colors hover:border-foreground/40 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ItemTypeIcon type={type} width={20} height={20} aria-hidden="true" />
            {ITEM_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
    </div>
  );
}
