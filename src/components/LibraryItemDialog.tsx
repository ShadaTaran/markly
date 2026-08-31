import type {
  MediaItem,
  MediaItemInput,
  SupportedItemType,
  WebsiteItem,
  WebsiteItemInput,
} from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { Dialog } from "@/components/Dialog";
import { ItemTypePicker } from "@/components/ItemTypePicker";
import { WebsiteItemForm } from "@/components/WebsiteItemForm";
import { MediaItemForm } from "@/components/MediaItemForm";

export type DialogState =
  | { step: "pickType" }
  | { step: "form"; mode: "add"; itemType: SupportedItemType }
  | { step: "form"; mode: "edit"; itemType: SupportedItemType; item: WebsiteItem | MediaItem }
  | null;

interface LibraryItemDialogProps {
  state: DialogState;
  existingCategories: string[];
  onSelectType: (type: SupportedItemType) => void;
  onBackToPicker: () => void;
  onClose: () => void;
  onSubmitWebsite: (values: WebsiteItemInput) => void;
  onSubmitMedia: (values: MediaItemInput) => void;
}

export function LibraryItemDialog({
  state,
  existingCategories,
  onSelectType,
  onBackToPicker,
  onClose,
  onSubmitWebsite,
  onSubmitMedia,
}: LibraryItemDialogProps) {
  const title =
    state?.step === "form"
      ? `${state.mode === "edit" ? "Edit" : "Add"} ${ITEM_TYPE_LABELS[state.itemType]}`
      : "Add Item";

  const onBack = state?.step === "form" && state.mode === "add" ? onBackToPicker : undefined;

  return (
    <Dialog isOpen={state !== null} onClose={onClose} onBack={onBack} title={title}>
      {state?.step === "pickType" && <ItemTypePicker onSelect={onSelectType} />}

      {state?.step === "form" && state.itemType === "website" && (
        <WebsiteItemForm
          key={state.mode === "edit" ? state.item.id : "new"}
          initialValues={
            state.mode === "edit" && state.item.type === "website" ? state.item : undefined
          }
          existingCategories={existingCategories}
          onSubmit={onSubmitWebsite}
          onCancel={onClose}
        />
      )}

      {state?.step === "form" && state.itemType !== "website" && (
        <MediaItemForm
          key={state.mode === "edit" ? state.item.id : "new"}
          type={state.itemType}
          initialValues={
            state.mode === "edit" && state.item.type !== "website" ? state.item : undefined
          }
          existingCategories={existingCategories}
          onSubmit={onSubmitMedia}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}
