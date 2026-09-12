/**
 * Stage 29 — bounds for untrusted backup files. No equivalent limits exist
 * elsewhere in the app (the add/edit forms never cap string length), so
 * these are new, scoped specifically to import: a hand-edited or malicious
 * JSON file has no natural size limit the way normal UI input does. Chosen
 * generously above any realistic real library (see README "Portable
 * Backup, Export & Import") while still bounding worst-case parse/DB work
 * to something a single request/transaction can handle comfortably.
 */

/** Rejected before JSON.parse even runs — checked against File.size directly. */
export const MAX_BACKUP_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

export const MAX_LIBRARY_ITEMS = 5000;
export const MAX_COLLECTIONS = 200;
export const MAX_ACTIVITY_EVENTS = 50000;
export const MAX_ITEM_IDS_PER_COLLECTION = MAX_LIBRARY_ITEMS;
/** Stage 40 — generous relative to MAX_LIBRARY_ITEMS (a real item rarely has more than a handful of linked sources), matching the same "bound the untrusted-file worst case, never a realistic library" philosophy as every other limit here. */
export const MAX_TRACKING_SOURCES = 20000;

export const MAX_TITLE_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_CATEGORY_LENGTH = 100;
export const MAX_COLLECTION_NAME_LENGTH = 200;
export const MAX_URL_LENGTH = 2000;
export const MAX_STRING_ARRAY_LENGTH = 50; // tags, genres, authors, catalogPlatforms
export const MAX_STRING_ARRAY_ITEM_LENGTH = 100;
// Stage 40 — tracking_sources field bounds. adapter_id/source_key have no
// natural length limit in the schema itself (source_key is frequently an
// adapter-defined opaque id, not always a URL), so these are generous
// application-level ceilings for untrusted backup input only.
export const MAX_ADAPTER_ID_LENGTH = 100;
export const MAX_SOURCE_KEY_LENGTH = MAX_URL_LENGTH;
export const MAX_SOURCE_TITLE_LENGTH = 200;
