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
import { MetadataSearchPanel } from "@/components/MetadataSearchPanel";
import { CatalogTrackingForm, type PersonalTrackingValues } from "@/components/CatalogTrackingForm";
import type { MetadataDetails } from "@/lib/metadata/types";
import {
  buildCatalogDisplayFromItem,
  buildCatalogDisplayFromPrefill,
  buildCatalogMediaInput,
  buildInitialTrackingFromItem,
  buildPersonalOnlyMediaInput,
  getCatalogTotals,
  hasCatalogSource,
} from "@/lib/metadata/catalog-item";

export type DialogState =
  | { step: "pickType" }
  | { step: "search"; mode: "add"; itemType: MediaItem["type"] }
  | { step: "form"; mode: "add"; itemType: SupportedItemType; prefill?: MetadataDetails; showFullForm?: boolean }
  | { step: "form"; mode: "edit"; itemType: SupportedItemType; item: WebsiteItem | MediaItem; showFullForm?: boolean }
  | null;

interface LibraryItemDialogProps {
  state: DialogState;
  existingCategories: string[];
  onSelectType: (type: SupportedItemType) => void;
  onSelectSearchResult: (details: MetadataDetails) => void;
  onManualEntry: () => void;
  onBackToPicker: () => void;
  onBackToSearch: () => void;
  onToggleFullForm: () => void;
  onClose: () => void;
  onSubmitWebsite: (values: WebsiteItemInput) => void;
  onSubmitMedia: (values: MediaItemInput) => void;
}

export function LibraryItemDialog({
  state,
  existingCategories,
  onSelectType,
  onSelectSearchResult,
  onManualEntry,
  onBackToPicker,
  onBackToSearch,
  onToggleFullForm,
  onClose,
  onSubmitWebsite,
  onSubmitMedia,
}: LibraryItemDialogProps) {
  const title =
    state?.step === "search"
      ? `Search ${ITEM_TYPE_LABELS[state.itemType]}`
      : state?.step === "form"
        ? `${state.mode === "edit" ? "Edit" : "Add"} ${ITEM_TYPE_LABELS[state.itemType]}`
        : "Add Item";

  const onBack =
    state?.step === "search"
      ? onBackToPicker
      : state?.step === "form" && state.mode === "add"
        ? state.itemType === "website"
          ? onBackToPicker
          : onBackToSearch
        : undefined;

  // A media item is "catalog-backed" when adding with a selected search
  // result, or editing an item that was originally imported that way. Such
  // items get the compact progress+rating review form instead of the full
  // manual-entry form, unless the user explicitly asked to see everything
  // via "Edit full details".
  const isMediaForm = state?.step === "form" && state.itemType !== "website";
  const mediaItem =
    state?.step === "form" && state.mode === "edit" && state.item.type !== "website" ? state.item : undefined;
  const isCatalogBacked =
    state?.step === "form" &&
    (state.mode === "add" ? Boolean(state.prefill) : mediaItem !== undefined && hasCatalogSource(mediaItem));
  const useCompactForm = isMediaForm && isCatalogBacked && !state.showFullForm;

  // Plain top-level consts (rather than repeated `state.prefill`/`state.itemType`
  // property reads) so their narrowed types survive being read inside the
  // onSubmit closures below.
  const addItemType =
    state?.step === "form" && state.mode === "add" && state.itemType !== "website" ? state.itemType : undefined;
  const addPrefill = state?.step === "form" && state.mode === "add" ? state.prefill : undefined;

  return (
    <Dialog isOpen={state !== null} onClose={onClose} onBack={onBack} title={title}>
      {state?.step === "pickType" && <ItemTypePicker onSelect={onSelectType} />}

      {state?.step === "search" && (
        <MetadataSearchPanel
          key={state.itemType}
          itemType={state.itemType}
          onSelect={onSelectSearchResult}
          onManualEntry={onManualEntry}
        />
      )}

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

      {state?.step === "form" && state.itemType !== "website" && useCompactForm && state.mode === "add" && addItemType && addPrefill && (
        <CatalogTrackingForm
          key="new"
          type={addItemType}
          mode="add"
          display={buildCatalogDisplayFromPrefill(addItemType, addPrefill)}
          totalEpisodes={addPrefill.totalEpisodes}
          totalChapters={addPrefill.totalChapters}
          initial={{ status: "planned" }}
          onSubmit={(personal: PersonalTrackingValues) => {
            onSubmitMedia(buildCatalogMediaInput(addItemType, addPrefill, personal));
          }}
          onChangeSelection={onBackToSearch}
          onEditFullDetails={onToggleFullForm}
          onCancel={onClose}
        />
      )}

      {state?.step === "form" && state.itemType !== "website" && useCompactForm && state.mode === "edit" && mediaItem && (
        <CatalogTrackingForm
          key={mediaItem.id}
          type={state.itemType}
          mode="edit"
          display={buildCatalogDisplayFromItem(mediaItem)}
          {...getCatalogTotals(mediaItem)}
          initial={buildInitialTrackingFromItem(mediaItem)}
          onSubmit={(personal: PersonalTrackingValues) => {
            onSubmitMedia(buildPersonalOnlyMediaInput(mediaItem, personal));
          }}
          onEditFullDetails={onToggleFullForm}
          onCancel={onClose}
        />
      )}

      {state?.step === "form" && state.itemType !== "website" && !useCompactForm && (
        <MediaItemForm
          key={state.mode === "edit" ? state.item.id : "new"}
          type={state.itemType}
          initialValues={
            state.mode === "edit" && state.item.type !== "website" ? state.item : undefined
          }
          prefill={state.mode === "add" ? state.prefill : undefined}
          existingCategories={existingCategories}
          onSubmit={onSubmitMedia}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}
