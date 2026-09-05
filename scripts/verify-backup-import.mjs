#!/usr/bin/env node
// Verifies Stage 29 "Portable Backup, Export & Safe Import":
//   - lib/backup/validate.ts: the untrusted-input boundary — malformed
//     JSON, wrong format/version, oversized files, per-record dropping
//     of bad data, URL/date safety, duplicate/dangling backup ids
//     (Tests V)
//   - lib/backup/plan.ts: duplicate classification (catalog match vs
//     title match vs conflicting catalog), collection reuse-by-name,
//     Activity-idempotency-via-scoping (Tests P)
//   - lib/backup/apply-local.ts + export.ts: the full local round trip,
//     one of every media type, plus repeated-import idempotency (Tests R)
//   - lib/backup/apply-local.ts's computeLocalActivityRetention: the
//     Stage 29 Part B fix — local-mode Activity import capacity/
//     chronological-retention semantics, and preview/result count
//     accuracy against what actually persists (Tests B)
//   - supabase/migrations/0013_stage29_backup_import.sql: the cloud RPC's
//     INTENDED control flow, reproduced in JS (Tests C), including the
//     Part A fix — (user_id, id)-scoped request idempotency, cross-
//     account behavior, double-submit vs. later-reimport. This is an
//     ALGORITHM model, not a live database test — same caveat every
//     prior RPC-model script in this directory already carries
//     (verify-duplicate-merge.mjs, verify-library-recovery.mjs, ...).
//     0013 was deployed and validated against the real database first;
//     that pass found three genuine defects, all fixed in
//     supabase/migrations/0014_stage29_backup_import_fix.sql — which is
//     now ALSO deployed and has ITSELF been validated live, including a
//     genuine concurrent Promise.all reproduction of defect 3's exact
//     race condition (see the Stage 29 live-validation reports for both
//     rounds). This script's JS model (Tests C/A/D/E below) encodes the
//     same fixes as a fast, repeatable regression check — not a
//     replacement for that live validation, same caveat every prior
//     RPC-model script in this directory already carries
//     (verify-duplicate-merge.mjs, verify-library-recovery.mjs, ...):
//       1. import_library_backup's two `create temporary table`
//          statements had no `on commit drop`, so a pooled connection
//          reused for a second call failed with `42P07: relation
//          "import_item_map" already exists` — reproduced live pre-fix
//          (deterministic after a connection's first successful use),
//          and re-confirmed ABSENT post-fix (12 sequential + 5 concurrent
//          live calls, zero 42P07). Static file checks (Tests D) confirm
//          the fix stays in place; there is no JS analog of a Postgres
//          temp table/connection pool to model behaviorally.
//       2. the record-count bound check ran after the double-submit
//          guard's INSERT, so a rejected (`plan_too_large`) request id
//          was permanently consumed even though nothing was imported —
//          modeled behaviorally (Tests D) in importLibraryBackupModel,
//          and reconfirmed fixed live post-deployment.
//       3. same user, same normalized plan, two different request ids,
//          submitted independently — both could succeed and create TWO
//          copies of the same logical item, because neither call's
//          "new" classification was ever re-checked against what the
//          OTHER call had just committed. 0014 fixes this with a
//          per-user advisory lock (modeled here as strict sequential
//          calls — the lock's entire purpose is forcing that ordering
//          instead of true interleaving) plus commit-time identity
//          revalidation, reproduced in importLibraryBackupModel exactly
//          like lib/backup/plan.ts's own classifyItem/classifyCollection
//          (Tests E) — and reconfirmed live via genuine Promise.all
//          concurrency against the real deployed database: zero
//          race-created duplicate LibraryItems, for both the
//          authoritative-catalogSource and title-only cases.
//   - lib/backup/validate.ts's whole-file duplicate-id rejection: a
//     duplicate backupItemId or backupCollectionId now rejects the
//     entire backup as structurally invalid (never silently keeps the
//     first occurrence and drops the rest — Tests F).
//
// Reproduced verbatim from the real modules/SQL rather than imported —
// same approach as every other script in this directory (plain .mjs, no
// TypeScript loader available under the project's Node >=20.9 baseline).
//
// Run with: node scripts/verify-backup-import.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_0014_PATH = path.join(REPO_ROOT, "supabase", "migrations", "0014_stage29_backup_import_fix.sql");
function read0014() {
  return fs.readFileSync(MIGRATION_0014_PATH, "utf8");
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

// ============================================================
// Limits, reproduced from lib/backup/limits.ts
// ============================================================
const MAX_LIBRARY_ITEMS = 5000;
const MAX_COLLECTIONS = 200;
const MAX_ACTIVITY_EVENTS = 50000;
const MAX_ITEM_IDS_PER_COLLECTION = MAX_LIBRARY_ITEMS;
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_CATEGORY_LENGTH = 100;
const MAX_COLLECTION_NAME_LENGTH = 200;
const MAX_URL_LENGTH = 2000;
const MAX_STRING_ARRAY_LENGTH = 50;
const MAX_STRING_ARRAY_ITEM_LENGTH = 100;

// Local-mode's PRE-EXISTING persisted-history cap, reproduced from
// lib/activity-storage.ts's MAX_ACTIVITY_EVENTS. Deliberately a separate
// constant from the backup format's own MAX_ACTIVITY_EVENTS above (a
// file-size/record-count limit, 50000) — the two are unrelated numbers
// that happen to share a name in their respective source files.
const LOCAL_ACTIVITY_CAP = 500;

const BACKUP_FORMAT = "markly-backup";
const BACKUP_VERSION = 1;
const SUPPORTED_TYPES = new Set(["website", "anime", "manga", "novel", "game", "movie", "series"]);
const KNOWN_PROVIDERS = new Set(["anilist", "open-library", "tmdb", "rawg"]);
const TRACKING_STATUSES = new Set(["planned", "in_progress", "completed", "on_hold", "dropped"]);
const PROGRESS_KINDS = new Set(["episode", "chapter", "page", "percent", "playtime", "season_episode"]);

// ============================================================
// isValidUrl, reproduced from lib/website.ts
// ============================================================
function isValidUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    if (protocol !== "http:" && protocol !== "https:") return false;
    return hostname.length > 0 && (hostname.includes(".") || hostname === "localhost");
  } catch {
    return false;
  }
}

// ============================================================
// normalizeTitleForMatching, reproduced from lib/title-normalization.ts
// ============================================================
function normalizeTitleForMatching(title) {
  return title
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‒–—―]/g, "-")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// ============================================================
// validateBackupObject, reproduced from lib/backup/validate.ts
// ============================================================
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isValidIsoDate(v) {
  if (typeof v !== "string" || v.length === 0) return false;
  return Number.isFinite(new Date(v).getTime());
}
function isNonEmptyString(v, max) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}
function normalizeStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((e) => typeof e === "string" && e.length > 0 && e.length <= MAX_STRING_ARRAY_ITEM_LENGTH).slice(0, MAX_STRING_ARRAY_LENGTH);
}
function normalizeCatalogSource(v) {
  if (!isPlainObject(v)) return undefined;
  if (typeof v.provider !== "string" || !KNOWN_PROVIDERS.has(v.provider)) return undefined;
  if (typeof v.externalId !== "string" || v.externalId.length === 0 || v.externalId.length > 200) return undefined;
  return { provider: v.provider, externalId: v.externalId };
}
function normalizeUrlField(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_URL_LENGTH) return undefined;
  return isValidUrl(v) ? v : undefined;
}
function normalizeRating(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 10) return undefined;
  return Math.round(v * 2) / 2;
}
function normalizeStatus(v) {
  return typeof v === "string" && TRACKING_STATUSES.has(v) ? v : "planned";
}
function normalizeNonNegInt(v) {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : undefined;
}
function normalizePositiveInt(v) {
  const n = normalizeNonNegInt(v);
  return n !== undefined && n > 0 ? n : undefined;
}
function normalizeNonNegNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function validateLibraryItem(raw) {
  if (!isPlainObject(raw)) return null;
  const backupItemId = raw.backupItemId;
  if (typeof backupItemId !== "string" || backupItemId.length === 0) return null;
  if (typeof raw.type !== "string" || !SUPPORTED_TYPES.has(raw.type)) return null;
  if (!isNonEmptyString(raw.title, MAX_TITLE_LENGTH)) return null;
  if (!isValidIsoDate(raw.createdAt)) return null;

  if (raw.type === "website") {
    const url = normalizeUrlField(raw.url);
    if (!url) return null;
    return {
      backupItemId,
      type: "website",
      title: raw.title,
      description: typeof raw.description === "string" ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : "",
      category: typeof raw.category === "string" ? raw.category.slice(0, MAX_CATEGORY_LENGTH) : "",
      tags: normalizeStringArray(raw.tags),
      favorite: raw.favorite === true,
      createdAt: raw.createdAt,
      url,
    };
  }

  const item = {
    backupItemId,
    type: raw.type,
    title: raw.title,
    description: typeof raw.description === "string" ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : "",
    category: typeof raw.category === "string" ? raw.category.slice(0, MAX_CATEGORY_LENGTH) : "",
    tags: normalizeStringArray(raw.tags),
    favorite: raw.favorite === true,
    createdAt: raw.createdAt,
    imageUrl: normalizeUrlField(raw.imageUrl),
    sourceUrl: normalizeUrlField(raw.sourceUrl),
    releaseYear: normalizePositiveInt(raw.releaseYear),
    catalogSource: normalizeCatalogSource(raw.catalogSource),
    status: normalizeStatus(raw.status),
    rating: normalizeRating(raw.rating),
  };
  switch (raw.type) {
    case "anime":
    case "series":
      item.currentEpisode = normalizeNonNegInt(raw.currentEpisode);
      item.totalEpisodes = normalizePositiveInt(raw.totalEpisodes);
      item.episodeNumbering = raw.episodeNumbering === "seasonal" || raw.episodeNumbering === "absolute" ? raw.episodeNumbering : undefined;
      item.currentSeason = item.episodeNumbering === "seasonal" ? normalizePositiveInt(raw.currentSeason) : undefined;
      item.genres = normalizeStringArray(raw.genres);
      if (raw.type === "anime") item.studio = isNonEmptyString(raw.studio, MAX_STRING_ARRAY_ITEM_LENGTH) ? raw.studio : undefined;
      break;
    case "manga":
      item.currentChapter = normalizeNonNegNumber(raw.currentChapter);
      item.totalChapters = normalizePositiveInt(raw.totalChapters);
      item.genres = normalizeStringArray(raw.genres);
      item.authors = normalizeStringArray(raw.authors);
      break;
    case "novel": {
      const unit = raw.progressUnit === "chapter" || raw.progressUnit === "page" || raw.progressUnit === "percent" ? raw.progressUnit : undefined;
      item.progressUnit = unit;
      item.progressValue = unit === undefined ? undefined : unit === "percent" ? (raw.progressValue >= 0 && raw.progressValue <= 100 ? raw.progressValue : undefined) : normalizeNonNegNumber(raw.progressValue);
      item.authors = normalizeStringArray(raw.authors);
      item.pageCount = normalizePositiveInt(raw.pageCount);
      item.readingFormat = ["book", "light_novel", "web_novel"].includes(raw.readingFormat) ? raw.readingFormat : undefined;
      break;
    }
    case "movie":
      item.genres = normalizeStringArray(raw.genres);
      break;
    case "game":
      item.platform = isNonEmptyString(raw.platform, MAX_STRING_ARRAY_ITEM_LENGTH) ? raw.platform : undefined;
      item.playtimeHours = normalizeNonNegNumber(raw.playtimeHours);
      item.developer = isNonEmptyString(raw.developer, MAX_STRING_ARRAY_ITEM_LENGTH) ? raw.developer : undefined;
      item.publisher = isNonEmptyString(raw.publisher, MAX_STRING_ARRAY_ITEM_LENGTH) ? raw.publisher : undefined;
      item.catalogPlatforms = normalizeStringArray(raw.catalogPlatforms);
      break;
  }
  return item;
}

function validateCollection(raw, validItemIds, exportedAt) {
  if (!isPlainObject(raw)) return null;
  const id = raw.backupCollectionId;
  if (typeof id !== "string" || id.length === 0) return null;
  if (!isNonEmptyString(raw.name, MAX_COLLECTION_NAME_LENGTH)) return null;
  const itemIds = Array.isArray(raw.itemIds) ? raw.itemIds.filter((x) => typeof x === "string" && validItemIds.has(x)).slice(0, MAX_ITEM_IDS_PER_COLLECTION) : [];
  return { backupCollectionId: id, name: raw.name, description: typeof raw.description === "string" ? raw.description : undefined, createdAt: isValidIsoDate(raw.createdAt) ? raw.createdAt : exportedAt, itemIds };
}

/** Mirrors validate.ts's hasDuplicateId — backup-local ids define graph identity, so a duplicate makes any reference structurally ambiguous. */
function hasDuplicateId(records, idField) {
  const seen = new Set();
  for (const raw of records) {
    if (!isPlainObject(raw)) continue;
    const id = raw[idField];
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

function validateActivityEvent(raw, validItemIds) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.itemId !== "string" || !validItemIds.has(raw.itemId)) return null;
  if (!isValidIsoDate(raw.timestamp)) return null;
  switch (raw.type) {
    case "progress_updated":
      if (!PROGRESS_KINDS.has(raw.progressKind)) return null;
      if (typeof raw.newValue !== "number" || !Number.isFinite(raw.newValue)) return null;
      return { itemId: raw.itemId, type: "progress_updated", timestamp: raw.timestamp, progressKind: raw.progressKind, previousValue: typeof raw.previousValue === "number" ? raw.previousValue : undefined, newValue: raw.newValue };
    case "rating_updated":
      return { itemId: raw.itemId, type: "rating_updated", timestamp: raw.timestamp, previousValue: typeof raw.previousValue === "number" ? raw.previousValue : undefined, newValue: typeof raw.newValue === "number" ? raw.newValue : undefined };
    case "status_updated":
      if (!TRACKING_STATUSES.has(raw.newValue)) return null;
      return { itemId: raw.itemId, type: "status_updated", timestamp: raw.timestamp, previousValue: TRACKING_STATUSES.has(raw.previousValue) ? raw.previousValue : undefined, newValue: raw.newValue };
    case "item_added":
      return { itemId: raw.itemId, type: "item_added", timestamp: raw.timestamp };
    default:
      return null;
  }
}

function validateBackupObject(raw) {
  if (!isPlainObject(raw) || raw.format !== BACKUP_FORMAT) return { ok: false, reason: "wrong_format", message: "Not a Markly backup." };
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  if (raw.version > BACKUP_VERSION) return { ok: false, reason: "unsupported_version", message: "This backup uses a newer unsupported version." };
  if (!isValidIsoDate(raw.exportedAt)) return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  if (!isPlainObject(raw.data)) return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };

  const { libraryItems: ri, collections: rc, activityEvents: ra } = raw.data;
  if ((ri !== undefined && !Array.isArray(ri)) || (rc !== undefined && !Array.isArray(rc)) || (ra !== undefined && !Array.isArray(ra))) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }
  const itemsArray = Array.isArray(ri) ? ri : [];
  const collectionsArray = Array.isArray(rc) ? rc : [];
  const activityArray = Array.isArray(ra) ? ra : [];
  if (itemsArray.length > MAX_LIBRARY_ITEMS || collectionsArray.length > MAX_COLLECTIONS || activityArray.length > MAX_ACTIVITY_EVENTS) {
    return { ok: false, reason: "too_many_records", message: "This backup is too large to import." };
  }

  // Whole-file structural rejection on duplicate backup-local ids —
  // never silently keep the first occurrence (Issue B fix). Runs before
  // any per-record validation, preview, or mutation.
  if (hasDuplicateId(itemsArray, "backupItemId") || hasDuplicateId(collectionsArray, "backupCollectionId")) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }

  const libraryItems = [];
  let skippedItems = 0;
  for (const r of itemsArray) {
    const item = validateLibraryItem(r);
    if (item) libraryItems.push(item);
    else skippedItems++;
  }
  const validItemIds = new Set(libraryItems.map((i) => i.backupItemId));

  const collections = [];
  let skippedCollections = 0;
  for (const r of collectionsArray) {
    const c = validateCollection(r, validItemIds, raw.exportedAt);
    if (c) collections.push(c);
    else skippedCollections++;
  }

  const activityEvents = [];
  let skippedActivity = 0;
  for (const r of activityArray) {
    const e = validateActivityEvent(r, validItemIds);
    if (e) activityEvents.push(e);
    else skippedActivity++;
  }

  if (itemsArray.length > 0 && libraryItems.length === 0) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }

  return {
    ok: true,
    backup: { exportedAt: raw.exportedAt, backupId: typeof raw.backupId === "string" ? raw.backupId : "", libraryItems, collections, activityEvents, skipped: { libraryItems: skippedItems, collections: skippedCollections, activityEvents: skippedActivity } },
  };
}

// ============================================================
// buildImportPlan, reproduced from lib/backup/plan.ts
// ============================================================
function classifyItem(backupItem, currentItems) {
  if (backupItem.type === "website") {
    const match = currentItems.find((i) => i.type === "website" && i.url === backupItem.url);
    return match ? { classification: "already_present", existingItemId: match.id } : { classification: "new" };
  }
  const currentMedia = currentItems.filter((i) => i.type === backupItem.type);
  if (backupItem.catalogSource) {
    const catalogMatch = currentMedia.find((i) => i.catalogSource && i.catalogSource.provider === backupItem.catalogSource.provider && i.catalogSource.externalId === backupItem.catalogSource.externalId);
    if (catalogMatch) return { classification: "already_present", existingItemId: catalogMatch.id };
  }
  const titleKey = normalizeTitleForMatching(backupItem.title);
  const titleMatch = currentMedia.find((i) => {
    if (normalizeTitleForMatching(i.title) !== titleKey) return false;
    if (backupItem.catalogSource && i.catalogSource) {
      return i.catalogSource.provider === backupItem.catalogSource.provider && i.catalogSource.externalId === backupItem.catalogSource.externalId;
    }
    return true;
  });
  if (titleMatch) return { classification: "possible_duplicate" };
  return { classification: "new" };
}
function classifyCollection(backupCollection, currentCollections) {
  const key = backupCollection.name.trim().toLowerCase();
  const existing = currentCollections.find((c) => c.name.trim().toLowerCase() === key);
  return existing ? { backupCollection, action: "reuse", existingCollectionId: existing.id } : { backupCollection, action: "create" };
}
function buildImportPlan(backup, currentItems, currentCollections, options) {
  const items = backup.libraryItems.map((backupItem) => {
    const { classification, existingItemId } = classifyItem(backupItem, currentItems);
    const action = classification === "new" || (classification === "possible_duplicate" && options.includePossibleDuplicates) ? "create" : "skip";
    return { backupItem, classification, action, existingItemId };
  });
  const resolvedItemIds = new Set(items.filter((e) => e.action === "create").map((e) => e.backupItem.backupItemId));
  const attachable = new Set([...resolvedItemIds, ...items.filter((e) => e.classification === "already_present").map((e) => e.backupItem.backupItemId)]);
  const collections = backup.collections.map((bc) => classifyCollection(bc, currentCollections));
  const memberships = [];
  for (const bc of backup.collections) {
    for (const itemId of bc.itemIds) {
      if (attachable.has(itemId)) memberships.push({ backupCollectionId: bc.backupCollectionId, backupItemId: itemId });
    }
  }
  const activityToImport = backup.activityEvents.filter((e) => resolvedItemIds.has(e.itemId));
  const dupTotal = items.filter((e) => e.classification === "possible_duplicate").length;
  return {
    items,
    collections,
    memberships,
    activityToImport,
    counts: {
      itemsNew: items.filter((e) => e.classification === "new").length,
      itemsAlreadyPresent: items.filter((e) => e.classification === "already_present").length,
      itemsPossibleDuplicate: dupTotal,
      itemsPossibleDuplicateIncluded: items.filter((e) => e.classification === "possible_duplicate" && e.action === "create").length,
      collectionsNew: collections.filter((e) => e.action === "create").length,
      collectionsReuse: collections.filter((e) => e.action === "reuse").length,
      activityImport: activityToImport.length,
      activitySkipped: backup.activityEvents.length - activityToImport.length,
    },
  };
}

// ============================================================
// applyImportPlanLocally, reproduced from lib/backup/apply-local.ts
// ============================================================
let idCounter = 0;
function genId() {
  return `gen-${++idCounter}`;
}
function fromBackupItem(b, id) {
  const base = { id, title: b.title, description: b.description, category: b.category, tags: b.tags, favorite: b.favorite, createdAt: b.createdAt };
  if (b.type === "website") return { ...base, type: "website", url: b.url };
  return { ...base, type: b.type, imageUrl: b.imageUrl, sourceUrl: b.sourceUrl, catalogSource: b.catalogSource, status: b.status ?? "planned", rating: b.rating, currentEpisode: b.currentEpisode, totalEpisodes: b.totalEpisodes, episodeNumbering: b.episodeNumbering, currentSeason: b.currentSeason, currentChapter: b.currentChapter, totalChapters: b.totalChapters, progressValue: b.progressValue, progressUnit: b.progressUnit, playtimeHours: b.playtimeHours, genres: b.genres, authors: b.authors };
}
// computeLocalActivityRetention, reproduced from lib/backup/apply-local.ts (Stage 29 Part B fix)
function computeLocalActivityRetention(currentEvents, newEvents, capacity) {
  const combined = [...currentEvents, ...newEvents];
  combined.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const kept = combined.length > capacity ? combined.slice(0, capacity) : combined;
  const keptIds = new Set(kept.map((e) => e.id));
  const importedCount = newEvents.filter((e) => keptIds.has(e.id)).length;
  return { events: kept, importedCount, skippedForCapacity: newEvents.length - importedCount };
}

function applyImportPlanLocally(plan, currentItems, currentCollections, currentEvents) {
  const newIdByBackupItemId = new Map();
  const newItems = [];
  for (const entry of plan.items) {
    if (entry.action !== "create") continue;
    const newId = genId();
    newIdByBackupItemId.set(entry.backupItem.backupItemId, newId);
    newItems.push(fromBackupItem(entry.backupItem, newId));
  }
  const resolvedItemId = new Map();
  for (const entry of plan.items) {
    if (entry.action === "create") resolvedItemId.set(entry.backupItem.backupItemId, newIdByBackupItemId.get(entry.backupItem.backupItemId));
    else if (entry.classification === "already_present") resolvedItemId.set(entry.backupItem.backupItemId, entry.existingItemId);
  }
  const membershipsByCollection = new Map();
  for (const m of plan.memberships) {
    const realId = resolvedItemId.get(m.backupItemId);
    if (!realId) continue;
    const set = membershipsByCollection.get(m.backupCollectionId) ?? new Set();
    set.add(realId);
    membershipsByCollection.set(m.backupCollectionId, set);
  }
  const reusedTargets = new Map(plan.collections.filter((e) => e.action === "reuse").map((e) => [e.existingCollectionId, e.backupCollection.backupCollectionId]));
  const collections = currentCollections.map((c) => {
    const bcid = reusedTargets.get(c.id);
    if (!bcid) return c;
    const toAdd = membershipsByCollection.get(bcid);
    if (!toAdd || toAdd.size === 0) return c;
    const itemIds = [...c.itemIds];
    toAdd.forEach((id) => { if (!itemIds.includes(id)) itemIds.push(id); });
    return { ...c, itemIds };
  });
  for (const entry of plan.collections) {
    if (entry.action !== "create") continue;
    const toAdd = membershipsByCollection.get(entry.backupCollection.backupCollectionId);
    collections.push({ id: genId(), name: entry.backupCollection.name, description: entry.backupCollection.description, itemIds: toAdd ? [...toAdd] : [], createdAt: entry.backupCollection.createdAt });
  }
  const newEvents = [...plan.activityToImport]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((e) => ({ id: genId(), itemId: resolvedItemId.get(e.itemId), timestamp: e.timestamp, type: e.type, progressKind: e.progressKind, previousValue: e.previousValue, newValue: e.newValue }));
  const retained = computeLocalActivityRetention(currentEvents, newEvents, LOCAL_ACTIVITY_CAP);
  return {
    items: [...currentItems, ...newItems],
    collections,
    events: retained.events,
    activityImportedCount: retained.importedCount,
    activitySkippedForCapacity: retained.skippedForCapacity,
  };
}

// saveActivity's trim, reproduced from lib/activity-storage.ts — used
// only by the B-TEST4 reload-parity check below, to confirm the
// persistence layer's own (unmodified) trim is a no-op against an
// already-retained result.
function saveActivityModel(events) {
  return events.length > LOCAL_ACTIVITY_CAP ? events.slice(0, LOCAL_ACTIVITY_CAP) : events;
}

function buildBackupFromItems(items, collections, events) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    backupId: genId(),
    data: {
      libraryItems: items.map((i) => ({ backupItemId: i.id, type: i.type, title: i.title, description: i.description, category: i.category, tags: i.tags, favorite: i.favorite, createdAt: i.createdAt, url: i.url, imageUrl: i.imageUrl, sourceUrl: i.sourceUrl, catalogSource: i.catalogSource, status: i.status, rating: i.rating, currentEpisode: i.currentEpisode, totalEpisodes: i.totalEpisodes, episodeNumbering: i.episodeNumbering, currentSeason: i.currentSeason, currentChapter: i.currentChapter, totalChapters: i.totalChapters, progressValue: i.progressValue, progressUnit: i.progressUnit, playtimeHours: i.playtimeHours, genres: i.genres, authors: i.authors })),
      collections: collections.map((c) => ({ backupCollectionId: c.id, name: c.name, description: c.description, createdAt: c.createdAt, itemIds: c.itemIds })),
      activityEvents: events.map((e) => ({ itemId: e.itemId, type: e.type, timestamp: e.timestamp, progressKind: e.progressKind, previousValue: e.previousValue, newValue: e.newValue })),
    },
  };
}

// ============================================================
// Test helpers
// ============================================================
function mediaItem(overrides) {
  return { id: genId(), type: "anime", title: "Test", description: "", category: "", tags: [], favorite: false, createdAt: "2026-01-01T00:00:00.000Z", status: "in_progress", ...overrides };
}
/** `count` ActivityEvents on `itemId`, one per day starting at `startIso`, strictly ascending — index order IS chronological order, so tests can reason about "the Nth oldest/newest" by array index. */
function makeManyEvents(itemId, count, startIso) {
  const base = new Date(startIso).getTime();
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: genId(), itemId, type: "item_added", timestamp: new Date(base + i * 86400000).toISOString() });
  }
  return out;
}

// ============================================================
// V — validator (untrusted input)
// ============================================================
check("V1: rejects a non-object root", () => {
  assert.deepEqual(validateBackupObject("garbage"), { ok: false, reason: "wrong_format", message: "Not a Markly backup." });
});
check("V2: rejects the wrong format string", () => {
  const r = validateBackupObject({ format: "some-other-app-export", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", data: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong_format");
});
check("V3: rejects a version newer than supported", () => {
  const r = validateBackupObject({ format: BACKUP_FORMAT, version: 99, exportedAt: "2026-01-01T00:00:00.000Z", data: {} });
  assert.deepEqual(r, { ok: false, reason: "unsupported_version", message: "This backup uses a newer unsupported version." });
});
check("V4: rejects malformed JSON (simulated: JSON.parse throwing upstream)", () => {
  assert.throws(() => JSON.parse("{not valid json"));
});
check("V5: rejects a missing/invalid exportedAt", () => {
  const r = validateBackupObject({ format: BACKUP_FORMAT, version: 1, exportedAt: "not-a-date", data: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "malformed_root");
});
check("V6: rejects data that isn't an object", () => {
  const r = validateBackupObject({ format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z", data: "nope" });
  assert.equal(r.ok, false);
});
check("V7: rejects a too-many-records file (structural, all-or-nothing)", () => {
  const items = Array.from({ length: MAX_LIBRARY_ITEMS + 1 }, (_, i) => ({ backupItemId: `i${i}`, type: "website", title: "x", url: "https://example.com", createdAt: "2026-01-01T00:00:00.000Z" }));
  const r = validateBackupObject({ format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z", data: { libraryItems: items, collections: [], activityEvents: [] } });
  assert.deepEqual(r, { ok: false, reason: "too_many_records", message: "This backup is too large to import." });
});
check("V8: drops one malformed item but keeps the rest valid (per-record, not all-or-nothing)", () => {
  const r = validateBackupObject({
    format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
    data: { libraryItems: [
      { backupItemId: "ok", type: "website", title: "Good", url: "https://example.com", createdAt: "2026-01-01T00:00:00.000Z" },
      { backupItemId: "bad", type: "website", title: "Bad URL", url: "javascript:alert(1)", createdAt: "2026-01-01T00:00:00.000Z" },
    ], collections: [], activityEvents: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.backup.libraryItems.length, 1);
  assert.equal(r.backup.skipped.libraryItems, 1);
});
check("V9: rejects javascript:/data:/file: URLs, accepts http/https", () => {
  assert.equal(isValidUrl("javascript:alert(1)"), false);
  assert.equal(isValidUrl("data:text/html,hi"), false);
  assert.equal(isValidUrl("file:///etc/passwd"), false);
  assert.equal(isValidUrl("https://example.com/path"), true);
  assert.equal(isValidUrl("http://example.com"), true);
});
check("V10: rejects an item with an invalid createdAt (never falsifies as 'now')", () => {
  const r = validateLibraryItem({ backupItemId: "a", type: "manga", title: "T", createdAt: "not-a-date" });
  assert.equal(r, null);
});
check("V11: rejects an Activity event with an invalid timestamp — never substitutes 'now'", () => {
  const r = validateActivityEvent({ itemId: "a", type: "item_added", timestamp: "banana" }, new Set(["a"]));
  assert.equal(r, null);
});
check("V12: drops an Activity event referencing a missing backup item id", () => {
  const r = validateActivityEvent({ itemId: "ghost", type: "item_added", timestamp: "2026-01-01T00:00:00.000Z" }, new Set(["real"]));
  assert.equal(r, null);
});
check("V13: a duplicate backupItemId rejects the WHOLE backup as structurally invalid — never silently keeps the first occurrence (Issue B fix)", () => {
  const r = validateBackupObject({
    format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
    data: { libraryItems: [
      { backupItemId: "dup", type: "website", title: "First", url: "https://example.com", createdAt: "2026-01-01T00:00:00.000Z" },
      { backupItemId: "dup", type: "website", title: "Second", url: "https://example.org", createdAt: "2026-01-01T00:00:00.000Z" },
    ], collections: [], activityEvents: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "malformed_root");
});
check("V14: a collection's itemIds referencing a missing/invalid backup item are silently dropped, not the whole collection", () => {
  const c = validateCollection({ backupCollectionId: "c1", name: "Favorites", itemIds: ["real", "ghost"], createdAt: "2026-01-01T00:00:00.000Z" }, new Set(["real"]), "2026-01-01T00:00:00.000Z");
  assert.ok(c);
  assert.deepEqual(c.itemIds, ["real"]);
});
check("V15: clamps out-of-range numeric fields rather than rejecting the whole item (e.g. negative progress)", () => {
  const item = validateLibraryItem({ backupItemId: "a", type: "manga", title: "T", createdAt: "2026-01-01T00:00:00.000Z", currentChapter: -5 });
  assert.ok(item);
  assert.equal(item.currentChapter, undefined);
});
check("V16: rejects a malformed catalogSource by dropping just that field", () => {
  const item = validateLibraryItem({ backupItemId: "a", type: "anime", title: "T", createdAt: "2026-01-01T00:00:00.000Z", catalogSource: { provider: "not-a-real-provider", externalId: "1" } });
  assert.ok(item);
  assert.equal(item.catalogSource, undefined);
});
check("V17: an unsupported/generic type (e.g. 'article') is dropped, never silently coerced", () => {
  const item = validateLibraryItem({ backupItemId: "a", type: "article", title: "T", createdAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(item, null);
});
check("V18: an extremely long title is rejected (record dropped, not silently truncated into something misleading)", () => {
  const item = validateLibraryItem({ backupItemId: "a", type: "website", title: "x".repeat(MAX_TITLE_LENGTH + 1), url: "https://example.com", createdAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(item, null);
});
check("V19: a garbage/unrelated JSON object (unknown-fields-heavy) is safely rejected as wrong_format", () => {
  const r = validateBackupObject({ hello: "world", nested: { a: [1, 2, { __proto__: { polluted: true } }] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong_format");
});
check("V20: prototype-pollution-shaped keys in a record are inert (no special-cased traversal, plain property reads)", () => {
  const raw = JSON.parse('{"backupItemId":"a","type":"website","title":"T","url":"https://example.com","createdAt":"2026-01-01T00:00:00.000Z","__proto__":{"polluted":true}}');
  const item = validateLibraryItem(raw);
  assert.ok(item);
  assert.equal({}.polluted, undefined, "no global prototype pollution occurred");
});
check("V21: an all-invalid non-empty items array is treated as a malformed file, not a suspiciously-empty success", () => {
  const r = validateBackupObject({ format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z", data: { libraryItems: [{ garbage: true }], collections: [], activityEvents: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "malformed_root");
});
check("V22: missing optional arrays default to empty rather than rejecting the file (forward-compatible)", () => {
  const r = validateBackupObject({ format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z", data: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.backup.libraryItems, []);
});

// ============================================================
// P — plan / duplicate classification
// ============================================================
check("P1: catalogSource match -> already_present, with an existingItemId mapping", () => {
  const backupItem = { backupItemId: "b1", type: "anime", title: "Frieren: Beyond Journey's End", catalogSource: { provider: "anilist", externalId: "154587" } };
  const current = [mediaItem({ id: "cur-1", type: "anime", title: "Frieren", catalogSource: { provider: "anilist", externalId: "154587" } })];
  const { classification, existingItemId } = classifyItem(backupItem, current);
  assert.equal(classification, "already_present");
  assert.equal(existingItemId, "cur-1");
});
check("P2: exact normalized title match, no catalog conflict -> possible_duplicate (never already_present)", () => {
  const backupItem = { backupItemId: "b1", type: "novel", title: "Lord of the Mysteries" };
  const current = [mediaItem({ id: "cur-1", type: "novel", title: "Lord of the Mysteries" })];
  assert.deepEqual(classifyItem(backupItem, current), { classification: "possible_duplicate" });
});
check("P3: 'Lord of Mysteries' vs 'Lord of the Mysteries' -> never matched (no fuzzy matching)", () => {
  const backupItem = { backupItemId: "b1", type: "novel", title: "Lord of Mysteries" };
  const current = [mediaItem({ id: "cur-1", type: "novel", title: "Lord of the Mysteries" })];
  assert.deepEqual(classifyItem(backupItem, current), { classification: "new" });
});
check("P4: Anime Frieren vs Manga Frieren -> never cross-type matched", () => {
  const backupItem = { backupItemId: "b1", type: "anime", title: "Frieren" };
  const current = [mediaItem({ id: "cur-1", type: "manga", title: "Frieren" })];
  assert.deepEqual(classifyItem(backupItem, current), { classification: "new" });
});
check("P5: conflicting catalog ids on an otherwise-title-matching pair -> new, never merged/flagged", () => {
  const backupItem = { backupItemId: "b1", type: "anime", title: "Same Title", catalogSource: { provider: "anilist", externalId: "111" } };
  const current = [mediaItem({ id: "cur-1", type: "anime", title: "Same Title", catalogSource: { provider: "anilist", externalId: "222" } })];
  assert.deepEqual(classifyItem(backupItem, current), { classification: "new" });
});
check("P6: exact-URL match for a website item -> already_present", () => {
  const backupItem = { backupItemId: "b1", type: "website", url: "https://example.com/page" };
  const current = [{ id: "cur-1", type: "website", url: "https://example.com/page" }];
  assert.deepEqual(classifyItem(backupItem, current), { classification: "already_present", existingItemId: "cur-1" });
});
check("P7: collection reuse by exact (trimmed, case-insensitive) name", () => {
  const c = classifyCollection({ backupCollectionId: "bc1", name: "  Favorites  " }, [{ id: "cur-c1", name: "favorites" }]);
  assert.deepEqual(c, { backupCollection: { backupCollectionId: "bc1", name: "  Favorites  " }, action: "reuse", existingCollectionId: "cur-c1" });
});
check("P8: no matching collection name -> create", () => {
  const c = classifyCollection({ backupCollectionId: "bc1", name: "Brand New" }, [{ id: "cur-c1", name: "Favorites" }]);
  assert.equal(c.action, "create");
});
check("P9: default policy — possible duplicates are skipped (action 'skip'), never merged automatically", () => {
  const backup = { libraryItems: [{ backupItemId: "b1", type: "novel", title: "Dup" }], collections: [], activityEvents: [] };
  const current = [mediaItem({ id: "cur-1", type: "novel", title: "Dup" })];
  const plan = buildImportPlan(backup, current, [], { includePossibleDuplicates: false });
  assert.equal(plan.items[0].action, "skip");
  assert.equal(plan.counts.itemsPossibleDuplicateIncluded, 0);
});
check("P10: opt-in checkbox creates the possible-duplicate as a genuinely separate NEW item, never mapped to the existing one", () => {
  const backup = { libraryItems: [{ backupItemId: "b1", type: "novel", title: "Dup" }], collections: [], activityEvents: [] };
  const current = [mediaItem({ id: "cur-1", type: "novel", title: "Dup" })];
  const plan = buildImportPlan(backup, current, [], { includePossibleDuplicates: true });
  assert.equal(plan.items[0].action, "create");
  assert.equal(plan.items[0].existingItemId, undefined, "never mapped/merged, even when included");
});
check("P11: a collection membership pointing to a skipped possible-duplicate is omitted, never dangling", () => {
  const backup = {
    libraryItems: [{ backupItemId: "b1", type: "novel", title: "Dup" }],
    collections: [{ backupCollectionId: "bc1", name: "List", itemIds: ["b1"] }],
    activityEvents: [],
  };
  const current = [mediaItem({ id: "cur-1", type: "novel", title: "Dup" })];
  const plan = buildImportPlan(backup, current, [], { includePossibleDuplicates: false });
  assert.deepEqual(plan.memberships, []);
});
check("P12: a collection membership for an already_present item maps to the EXISTING item (safe, authoritative identity)", () => {
  const backup = {
    libraryItems: [{ backupItemId: "b1", type: "anime", title: "X", catalogSource: { provider: "anilist", externalId: "9" } }],
    collections: [{ backupCollectionId: "bc1", name: "List", itemIds: ["b1"] }],
    activityEvents: [],
  };
  const current = [mediaItem({ id: "cur-1", type: "anime", title: "X-renamed", catalogSource: { provider: "anilist", externalId: "9" } })];
  const plan = buildImportPlan(backup, current, [], { includePossibleDuplicates: false });
  assert.deepEqual(plan.memberships, [{ backupCollectionId: "bc1", backupItemId: "b1" }]);
});
check("P13 (idempotency): Activity for an already_present item is NEVER imported, even though its collection membership is", () => {
  const backup = {
    libraryItems: [{ backupItemId: "b1", type: "anime", title: "X", catalogSource: { provider: "anilist", externalId: "9" } }],
    collections: [],
    activityEvents: [{ itemId: "b1", type: "item_added", timestamp: "2026-01-01T00:00:00.000Z" }],
  };
  const current = [mediaItem({ id: "cur-1", type: "anime", title: "X", catalogSource: { provider: "anilist", externalId: "9" } })];
  const plan = buildImportPlan(backup, current, [], { includePossibleDuplicates: false });
  assert.equal(plan.activityToImport.length, 0);
  assert.equal(plan.counts.activitySkipped, 1);
});
check("P14: Activity for a genuinely new item IS imported", () => {
  const backup = {
    libraryItems: [{ backupItemId: "b1", type: "anime", title: "Brand New" }],
    collections: [],
    activityEvents: [{ itemId: "b1", type: "item_added", timestamp: "2026-01-01T00:00:00.000Z" }],
  };
  const plan = buildImportPlan(backup, [], [], { includePossibleDuplicates: false });
  assert.equal(plan.activityToImport.length, 1);
});

// ============================================================
// R — round trip / local apply / repeated import
// ============================================================
check("R1: full round trip — one of every type, tags/favorites/ratings/metadata/collections/activity all preserved", () => {
  const website = { id: "w1", type: "website", title: "Site", description: "d", category: "dev", tags: ["a", "b"], favorite: true, createdAt: "2026-01-01T00:00:00.000Z", url: "https://example.com" };
  const novel = mediaItem({ id: "n1", type: "novel", title: "Novel", favorite: true, rating: 8.5, progressValue: 42, progressUnit: "chapter", tags: ["fantasy"] });
  const manga = mediaItem({ id: "m1", type: "manga", title: "Manga", currentChapter: 12.5, totalChapters: 100, genres: ["action"] });
  const animeAbs = mediaItem({ id: "a1", type: "anime", title: "AnimeAbs", currentEpisode: 5, totalEpisodes: 24, studio: "Studio X" });
  const seriesSeasonal = mediaItem({ id: "s1", type: "series", title: "SeriesSeasonal", currentEpisode: 3, currentSeason: 2, episodeNumbering: "seasonal" });
  const game = mediaItem({ id: "g1", type: "game", title: "Game", playtimeHours: 15.5, platform: "PC", developer: "Dev Co" });
  const movie = mediaItem({ id: "mv1", type: "movie", title: "Movie", rating: 10 });
  const items = [website, novel, manga, animeAbs, seriesSeasonal, game, movie];
  const collections = [{ id: "c1", name: "Favorites", description: "my favs", itemIds: ["w1", "n1"], createdAt: "2026-01-02T00:00:00.000Z" }];
  const events = [
    { id: "e1", itemId: "n1", type: "item_added", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "e2", itemId: "n1", type: "progress_updated", progressKind: "chapter", previousValue: 0, newValue: 42, timestamp: "2026-01-03T00:00:00.000Z" },
  ];

  const backup = buildBackupFromItems(items, collections, events);
  const validated = validateBackupObject(backup);
  assert.equal(validated.ok, true, "export must validate cleanly");
  assert.equal(validated.backup.libraryItems.length, 7);

  const plan = buildImportPlan(validated.backup, [], [], { includePossibleDuplicates: false });
  assert.equal(plan.counts.itemsNew, 7);
  const applied = applyImportPlanLocally(plan, [], [], []);

  assert.equal(applied.items.length, 7);
  const importedNovel = applied.items.find((i) => i.title === "Novel");
  assert.equal(importedNovel.favorite, true);
  assert.equal(importedNovel.rating, 8.5);
  assert.equal(importedNovel.progressValue, 42);
  assert.deepEqual(importedNovel.tags, ["fantasy"]);
  const importedSeasonal = applied.items.find((i) => i.title === "SeriesSeasonal");
  assert.equal(importedSeasonal.episodeNumbering, "seasonal");
  assert.equal(importedSeasonal.currentSeason, 2);

  assert.equal(applied.collections.length, 1);
  assert.equal(applied.collections[0].itemIds.length, 2, "both website and novel membership preserved");

  assert.equal(applied.events.length, 2);
  const restoredProgress = applied.events.find((e) => e.type === "progress_updated");
  assert.equal(restoredProgress.newValue, 42);
  assert.equal(restoredProgress.timestamp, "2026-01-03T00:00:00.000Z", "historical timestamp preserved exactly");
});

check("R2 (idempotency): importing the same backup twice never doubles items/collections, and Activity is not duplicated", () => {
  const items = [mediaItem({ id: "n1", type: "novel", title: "Once", catalogSource: { provider: "anilist", externalId: "77" } })];
  const collections = [{ id: "c1", name: "Reading", itemIds: ["n1"], createdAt: "2026-01-01T00:00:00.000Z" }];
  const events = [{ id: "e1", itemId: "n1", type: "item_added", timestamp: "2026-01-01T00:00:00.000Z" }];
  const backup = buildBackupFromItems(items, collections, events);
  const validated = validateBackupObject(backup).backup;

  // First import into an empty library.
  const plan1 = buildImportPlan(validated, [], [], { includePossibleDuplicates: false });
  const after1 = applyImportPlanLocally(plan1, [], [], []);
  assert.equal(after1.items.length, 1);
  assert.equal(after1.events.length, 1);

  // Second import of the SAME backup, now against the post-import state.
  const plan2 = buildImportPlan(validated, after1.items, after1.collections, { includePossibleDuplicates: false });
  assert.equal(plan2.counts.itemsNew, 0, "the item is now classified already_present");
  assert.equal(plan2.counts.itemsAlreadyPresent, 1);
  assert.equal(plan2.activityToImport.length, 0, "Activity is never re-attached to an already-present item");
  const after2 = applyImportPlanLocally(plan2, after1.items, after1.collections, after1.events);
  assert.equal(after2.items.length, 1, "no duplicate LibraryItem");
  assert.equal(after2.collections.length, 1, "no duplicate Collection");
  assert.equal(after2.collections[0].itemIds.length, 1, "collection membership dedupes, not doubled");
  assert.equal(after2.events.length, 1, "no duplicate Activity");
});

check("R3: existing user data is never overwritten — an already_present item's current fields are untouched by import", () => {
  const backup = buildBackupFromItems([mediaItem({ id: "n1", type: "novel", title: "X", rating: 5, catalogSource: { provider: "anilist", externalId: "1" } })], [], []);
  const validated = validateBackupObject(backup).backup;
  const current = [mediaItem({ id: "cur-1", type: "novel", title: "X (renamed by me)", rating: 9, catalogSource: { provider: "anilist", externalId: "1" } })];
  const plan = buildImportPlan(validated, current, [], { includePossibleDuplicates: false });
  const applied = applyImportPlanLocally(plan, current, [], []);
  const survivor = applied.items.find((i) => i.id === "cur-1");
  assert.equal(survivor.title, "X (renamed by me)");
  assert.equal(survivor.rating, 9, "never overwritten by the imported value");
  assert.equal(applied.items.length, 1, "no new item created for an already_present match");
});

check("R4: import never invokes Stage 27 merge or fabricates 'item_added today' events for imported items", () => {
  const backup = buildBackupFromItems([mediaItem({ id: "n1", type: "novel", title: "Historical", createdAt: "2020-01-01T00:00:00.000Z" })], [], []);
  const validated = validateBackupObject(backup).backup;
  const plan = buildImportPlan(validated, [], [], { includePossibleDuplicates: false });
  const applied = applyImportPlanLocally(plan, [], [], []);
  assert.equal(applied.events.length, 0, "no synthetic item_added event was generated for the import itself");
  assert.equal(applied.items[0].createdAt, "2020-01-01T00:00:00.000Z", "original historical createdAt preserved, not replaced with 'now'");
});

// ============================================================
// B — local Activity capacity & chronological retention (Part B fix)
// ============================================================
check("B-TEST1: importing 400 Activity events into an empty local library retains all 400 (under the 500 cap)", () => {
  const item = mediaItem({ id: "n1", type: "novel", title: "History" });
  const events = makeManyEvents("n1", 400, "2026-01-01T00:00:00.000Z");
  const backup = buildBackupFromItems([item], [], events);
  const validated = validateBackupObject(backup).backup;
  const plan = buildImportPlan(validated, [], [], { includePossibleDuplicates: false });
  assert.equal(plan.activityToImport.length, 400);
  const applied = applyImportPlanLocally(plan, [], [], []);
  assert.equal(applied.events.length, 400);
  assert.equal(applied.activityImportedCount, 400);
  assert.equal(applied.activitySkippedForCapacity, 0);
});

check("B-TEST2: importing 700 Activity events into an empty local library caps at 500, retaining the MOST RECENT 500 by timestamp (not the first 500 generated)", () => {
  const item = mediaItem({ id: "n1", type: "novel", title: "Long History" });
  const events = makeManyEvents("n1", 700, "2026-01-01T00:00:00.000Z");
  const backup = buildBackupFromItems([item], [], events);
  const validated = validateBackupObject(backup).backup;
  const plan = buildImportPlan(validated, [], [], { includePossibleDuplicates: false });
  assert.equal(plan.activityToImport.length, 700);
  const applied = applyImportPlanLocally(plan, [], [], []);
  assert.equal(applied.events.length, LOCAL_ACTIVITY_CAP, "durable local Activity never exceeds the 500-event cap");
  assert.equal(applied.activityImportedCount, LOCAL_ACTIVITY_CAP);
  assert.equal(applied.activitySkippedForCapacity, 200);
  const survivingTimestamps = applied.events.map((e) => e.timestamp).sort();
  assert.equal(survivingTimestamps[0], events[200].timestamp, "the oldest SURVIVING event is the 201st most-recent — the 200 oldest were dropped, not the 200 newest");
  assert.equal(survivingTimestamps[survivingTimestamps.length - 1], events[699].timestamp, "the single most recent event always survives");
});

check("B-TEST3 (B3/B4): existing 400 + backup 300 (all strictly more recent) at 500 capacity — the MORE RECENT imported history displaces the OLDER existing history by actual timestamp, never merely by array position", () => {
  const existingEvents = makeManyEvents("existing-item", 400, "2020-01-01T00:00:00.000Z");
  const item = mediaItem({ id: "n1", type: "novel", title: "Recent Import" });
  const backupRawEvents = makeManyEvents("n1", 300, "2026-01-01T00:00:00.000Z");
  const backup = buildBackupFromItems([item], [], backupRawEvents);
  const validated = validateBackupObject(backup).backup;
  const plan = buildImportPlan(validated, [], [], { includePossibleDuplicates: false });
  assert.equal(plan.activityToImport.length, 300);

  const applied = applyImportPlanLocally(plan, [], [], existingEvents);
  assert.equal(applied.events.length, LOCAL_ACTIVITY_CAP, "capacity is enforced across the COMBINED set, not per-source");
  assert.equal(applied.activityImportedCount, 300, "every imported event is more recent than the oldest existing ones, so all 300 survive");
  assert.equal(applied.activitySkippedForCapacity, 0, "none of the IMPORTED events were dropped in this scenario");

  const survivingExisting = applied.events.filter((e) => e.itemId === "existing-item");
  assert.equal(survivingExisting.length, 200, "only the 200 MOST RECENT existing events survive — the 200 oldest are displaced by more recent imported history");
  const oldestSurvivingExisting = survivingExisting.map((e) => e.timestamp).sort()[0];
  assert.equal(oldestSurvivingExisting, existingEvents[200].timestamp, "survivors are exactly the most-recent 200 existing events (index 200..399) by TIMESTAMP, confirming chronological (not array-order) retention — a naive 'existing array comes first, so it wins' policy would have wrongly kept all 400 existing and only 100 of the newer imported events");
});

check("B-TEST4 (reload parity): the persistence layer's own trim is a no-op against an already-retained import result — no further silent loss on save/reload", () => {
  const existingEvents = makeManyEvents("existing-item", 400, "2020-01-01T00:00:00.000Z");
  const item = mediaItem({ id: "n1", type: "novel", title: "Recent Import" });
  const backupRawEvents = makeManyEvents("n1", 300, "2026-01-01T00:00:00.000Z");
  const backup = buildBackupFromItems([item], [], backupRawEvents);
  const validated = validateBackupObject(backup).backup;
  const plan = buildImportPlan(validated, [], [], { includePossibleDuplicates: false });
  const applied = applyImportPlanLocally(plan, [], [], existingEvents);

  const afterSimulatedSaveAndReload = saveActivityModel(applied.events);
  assert.equal(afterSimulatedSaveAndReload.length, applied.events.length, "the existing persistence trim finds nothing left to do — the result was already durable");
  assert.deepEqual(
    new Set(afterSimulatedSaveAndReload.map((e) => e.id)),
    new Set(applied.events.map((e) => e.id)),
    "identical event identities before and after a simulated reload — no transient 'restored then disappeared' gap",
  );
});

check("B-TEST5 (preview/result accuracy): the reported durable count must reflect the local cap, never the raw mode-agnostic plan count", () => {
  const item = mediaItem({ id: "n1", type: "novel", title: "Long History" });
  const backupRawEvents = makeManyEvents("n1", 700, "2026-01-01T00:00:00.000Z");
  const backup = buildBackupFromItems([item], [], backupRawEvents);
  const validated = validateBackupObject(backup).backup;
  const plan = buildImportPlan(validated, [], [], { includePossibleDuplicates: false });
  assert.equal(plan.counts.activityImport, 700, "the mode-agnostic plan reports the full applicable count — local capacity is layered on top by the caller, never baked into the shared planner");
  const applied = applyImportPlanLocally(plan, [], [], []);
  assert.equal(applied.activityImportedCount, 500, "what's actually durable reflects the local cap");
  assert.notEqual(applied.activityImportedCount, plan.counts.activityImport, "BackupSettingsPanel must report applied.activityImportedCount for local mode, never plan.counts.activityImport verbatim, or it would claim more was restored than survives");
});

check("B5: cloud-mode Activity import is never local-capacity-limited — only local mode's applyImportPlanLocally applies the 500-event constant", () => {
  const db = makeDb();
  const rawEvents = makeManyEvents("b1", 700, "2026-01-01T00:00:00.000Z");
  const plan = {
    items: [{ backupItemId: "b1", type: "novel", title: "X" }],
    activity: rawEvents.map((e) => ({ backupItemId: e.itemId, type: e.type, timestamp: e.timestamp })),
  };
  const result = importLibraryBackupModel(db, "user-1", "req-cloud-700", plan);
  assert.equal(result.activityCreated, 700, "cloud import preserves the full Activity history within Stage 29's own record limits (up to MAX_ACTIVITY_EVENTS = 50000), not the local UI's 500-event display/storage cap");
  assert.equal(db.activityEvents.length, 700);
});

// ============================================================
// C/D/E — cloud RPC control-flow model (0013 deployed + 0014 fixes,
// 0014 itself NOT deployed — algorithm only)
// ============================================================
function makeDb() {
  // importRequests keys are "userId:requestId" — reproducing 0013's fixed
  // `primary key (user_id, id)` on backup_import_requests (Stage 29 Part
  // A fix; the table originally had a global `id uuid primary key`,
  // which would have let one user's row block a DIFFERENT user's later
  // use of the same literal request id — see A1/A4 below).
  return { libraryItems: new Map(), collections: new Map(), collectionItems: [], activityEvents: [], importRequests: new Set() };
}
function importLibraryBackupModel(db, userId, requestId, plan) {
  // 0014 DEFECT 2 fix: size checks run BEFORE the request-id insert, so a
  // rejected oversized plan never consumes it (see Tests D below).
  const itemCount = (plan.items ?? []).length;
  const collectionCreateCount = (plan.collectionsToCreate ?? []).length;
  const collectionReuseCount = (plan.collectionsToReuse ?? []).length;
  const mappingCount = (plan.itemMappings ?? []).length;
  const membershipCount = (plan.memberships ?? []).length;
  const activityCount = (plan.activity ?? []).length;
  if (
    itemCount > MAX_LIBRARY_ITEMS ||
    collectionCreateCount + collectionReuseCount > MAX_COLLECTIONS ||
    mappingCount > MAX_LIBRARY_ITEMS ||
    membershipCount > 250000 ||
    activityCount > MAX_ACTIVITY_EVENTS
  ) {
    return { status: "plan_too_large" };
  }

  const requestKey = `${userId}:${requestId}`;
  if (db.importRequests.has(requestKey)) return { status: "duplicate_request" };
  db.importRequests.add(requestKey);

  // 0014 DEFECT 3 fix: per-user pg_advisory_xact_lock has no direct JS
  // analog (this model is single-threaded and callers already invoke it
  // sequentially, which is exactly the ordering the lock forces instead
  // of true interleaving) — what DOES need modeling is what happens
  // under that lock: every "new" (non-opted-in) candidate is revalidated
  // against CURRENT db state before being created, using the identical
  // conservative rules classifyItem/classifyCollection already use.
  const itemMap = new Map(); // backupItemId -> { realId, wasCreated }
  let itemsCreated = 0, itemsReused = 0, collectionsCreated = 0, collectionsReused = 0, activityCreated = 0;
  const collectionMap = new Map();

  for (const item of plan.items ?? []) {
    if (!item.backupItemId || !item.type || !item.title) continue;

    if (!item.possibleDuplicateOptIn) {
      // Authoritative: same user, same type, same catalogSource.
      let existingId = null;
      if (item.catalogSource) {
        for (const [id, row] of db.libraryItems) {
          if (
            row.userId === userId &&
            row.type === item.type &&
            row.catalogSource &&
            row.catalogSource.provider === item.catalogSource.provider &&
            row.catalogSource.externalId === item.catalogSource.externalId
          ) {
            existingId = id;
            break;
          }
        }
      }
      if (existingId) {
        itemMap.set(item.backupItemId, { realId: existingId, wasCreated: false });
        itemsReused++;
        continue;
      }

      // Title-only: same user, same type, exact normalized title, no
      // conflicting catalogSource — never authoritative, so a match here
      // is neither created NOR mapped, just skipped (same as any other
      // unresolvable backup id — no dangling membership/Activity).
      const targetKey = normalizeTitleForMatching(item.title);
      let titleMatched = false;
      for (const [, row] of db.libraryItems) {
        if (row.userId !== userId || row.type !== item.type) continue;
        if (normalizeTitleForMatching(row.title) !== targetKey) continue;
        const conflicting =
          item.catalogSource &&
          row.catalogSource &&
          (row.catalogSource.provider !== item.catalogSource.provider || row.catalogSource.externalId !== item.catalogSource.externalId);
        if (conflicting) continue;
        titleMatched = true;
        break;
      }
      if (titleMatched) continue; // skip: no insert, no map entry
    }

    const id = genId();
    db.libraryItems.set(id, { id, userId, ...item });
    itemMap.set(item.backupItemId, { realId: id, wasCreated: true });
    itemsCreated++;
  }
  for (const c of plan.collectionsToCreate ?? []) {
    if (!c.backupCollectionId || !c.name) continue;
    let existingId = null;
    for (const [id, row] of db.collections) {
      if (row.userId === userId && row.name.trim().toLowerCase() === c.name.trim().toLowerCase()) {
        existingId = id;
        break;
      }
    }
    if (existingId) {
      collectionMap.set(c.backupCollectionId, existingId);
      collectionsReused++;
      continue;
    }
    const id = genId();
    db.collections.set(id, { id, userId, name: c.name });
    collectionMap.set(c.backupCollectionId, id);
    collectionsCreated++;
  }
  for (const c of plan.collectionsToReuse ?? []) {
    if (!c.backupCollectionId || !c.existingCollectionId) continue;
    const existing = db.collections.get(c.existingCollectionId);
    if (!existing || existing.userId !== userId) continue; // ownership re-verified server-side
    collectionMap.set(c.backupCollectionId, c.existingCollectionId);
    collectionsReused++;
  }
  for (const m of plan.itemMappings ?? []) {
    if (!m.backupItemId || !m.existingItemId) continue;
    const existing = db.libraryItems.get(m.existingItemId);
    if (!existing || existing.userId !== userId) continue; // ownership re-verified server-side
    itemMap.set(m.backupItemId, { realId: m.existingItemId, wasCreated: false });
  }
  for (const m of plan.memberships ?? []) {
    const col = collectionMap.get(m.backupCollectionId);
    const item = itemMap.get(m.backupItemId);
    if (!col || !item) continue;
    const key = `${col}:${item.realId}`;
    if (!db.collectionItems.some((ci) => `${ci.collectionId}:${ci.itemId}` === key)) {
      db.collectionItems.push({ collectionId: col, itemId: item.realId, userId });
    }
  }
  for (const a of plan.activity ?? []) {
    if (!a.backupItemId || !a.type || !a.timestamp) continue;
    const mapped = itemMap.get(a.backupItemId);
    if (!mapped || !mapped.wasCreated) continue; // server-side idempotency: only ever for items THIS call created
    db.activityEvents.push({ id: genId(), userId, itemId: mapped.realId, type: a.type, timestamp: a.timestamp });
    activityCreated++;
  }

  return { status: "imported", itemsCreated, itemsReused, collectionsCreated, collectionsReused, activityCreated };
}

check("C1: double-submit — the same request id is rejected the second time, no duplicate rows", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "novel", title: "X" }] };
  const r1 = importLibraryBackupModel(db, "user-1", "req-1", plan);
  const r2 = importLibraryBackupModel(db, "user-1", "req-1", plan);
  assert.equal(r1.status, "imported");
  assert.deepEqual(r2, { status: "duplicate_request" });
  assert.equal(db.libraryItems.size, 1, "only one item exists, not two");
});
check("C2: server re-verifies ownership of a claimed 'existing' item/collection — a foreign id is never trusted", () => {
  const db = makeDb();
  db.libraryItems.set("foreign-item", { id: "foreign-item", userId: "someone-else" });
  db.collections.set("foreign-col", { id: "foreign-col", userId: "someone-else" });
  const plan = {
    itemMappings: [{ backupItemId: "b1", existingItemId: "foreign-item" }],
    collectionsToReuse: [{ backupCollectionId: "bc1", existingCollectionId: "foreign-col" }],
    memberships: [{ backupCollectionId: "bc1", backupItemId: "b1" }],
  };
  const result = importLibraryBackupModel(db, "user-1", "req-2", plan);
  assert.equal(result.status, "imported");
  assert.equal(db.collectionItems.length, 0, "no membership created — neither foreign id was accepted");
});
check("C3: server never imports Activity for an already_present (mapped) item, even if the plan includes it — idempotency is re-enforced server-side, not just trusted from the client", () => {
  const db = makeDb();
  db.libraryItems.set("existing-1", { id: "existing-1", userId: "user-1" });
  const plan = {
    itemMappings: [{ backupItemId: "b1", existingItemId: "existing-1" }],
    activity: [{ backupItemId: "b1", type: "item_added", timestamp: "2026-01-01T00:00:00.000Z" }],
  };
  const result = importLibraryBackupModel(db, "user-1", "req-3", plan);
  assert.equal(result.activityCreated, 0);
  assert.equal(db.activityEvents.length, 0);
});
check("C4: user_id on every created row is always the calling user, never client-suppliable (no field for it exists in the plan)", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "novel", title: "X" }] };
  importLibraryBackupModel(db, "real-caller", "req-4", plan);
  const created = [...db.libraryItems.values()][0];
  assert.equal(created.userId, "real-caller");
});
check("C5: a membership referencing an unresolvable backup id (skipped duplicate) is silently omitted, never an error", () => {
  const db = makeDb();
  const plan = {
    items: [{ backupItemId: "b1", type: "novel", title: "X" }],
    collectionsToCreate: [{ backupCollectionId: "bc1", name: "List" }],
    memberships: [
      { backupCollectionId: "bc1", backupItemId: "b1" },
      { backupCollectionId: "bc1", backupItemId: "ghost" },
    ],
  };
  const result = importLibraryBackupModel(db, "user-1", "req-5", plan);
  assert.equal(result.status, "imported");
  assert.equal(db.collectionItems.length, 1, "only the resolvable membership was created");
});

// ============================================================
// A — import request idempotency & account scoping (Part A fix)
// ============================================================
check("A1 (cross-account): request uniqueness is USER-SCOPED — the SAME literal request id used by two different users never collides", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "novel", title: "X" }] };
  const r1 = importLibraryBackupModel(db, "user-A", "same-request-id", plan);
  const r2 = importLibraryBackupModel(db, "user-B", "same-request-id", plan);
  assert.equal(r1.status, "imported");
  assert.equal(r2.status, "imported", "User B must not be rejected merely because User A already used this exact request id");
  assert.equal(db.libraryItems.size, 2, "both users' items were created independently");
});

check("A2/A3 (double-submit vs. later reimport): two concurrent calls with the SAME request id collide; a NEW request id for a later, separate import attempt by the SAME user does not", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "novel", title: "X" }] };

  // A2 — double submit: same user, same confirmation action, same request id.
  const submit1 = importLibraryBackupModel(db, "user-1", "req-double-submit", plan);
  const submit2 = importLibraryBackupModel(db, "user-1", "req-double-submit", plan);
  assert.equal(submit1.status, "imported");
  assert.deepEqual(submit2, { status: "duplicate_request" });
  assert.equal(db.libraryItems.size, 1, "the double-submitted call created nothing");

  // A3 — reimport later: a genuinely separate import attempt (e.g. the
  // user reopens the same backup file another day) generates its OWN
  // fresh request id — never derived from backupId/file content — so it
  // is evaluated normally, not permanently blocked by the earlier row.
  const laterAttempt = importLibraryBackupModel(db, "user-1", "req-a-later-day", plan);
  assert.equal(laterAttempt.status, "imported", "a fresh request id for a later, intentional import attempt must never be blocked by an earlier, unrelated request id");
});

check("A4 (poisoning): pre-inserting a request row under one's OWN user id has ZERO effect on another user's request id namespace, by construction of the (user_id, id) key", () => {
  const db = makeDb();
  // An attacker consumes a guessable id for themselves first.
  importLibraryBackupModel(db, "attacker", "guessable-id", { items: [] });
  // The victim's own import, using the identical literal id string, is
  // completely unaffected — uniqueness is scoped to (user_id, id), not
  // to id alone, so there is no shared namespace to poison.
  const victimResult = importLibraryBackupModel(db, "victim", "guessable-id", { items: [{ backupItemId: "b1", type: "novel", title: "Victim Item" }] });
  assert.equal(victimResult.status, "imported", "the victim's request id namespace is untouched by another user's row under a different user_id");
});

// ============================================================
// D — 0014 fixes stay in place (static file checks + behavioral model)
// ============================================================
check("D1: ON COMMIT DROP is present for BOTH temp tables' actual CREATE statements in the final 0014 file", () => {
  const sql = read0014();
  // Match against the two CREATE TEMPORARY TABLE statements specifically
  // (not prose mentions elsewhere in the file's doc comments).
  assert.match(sql, /create temporary table pg_temp\.import_item_map \([^)]*\)\s*on commit drop;/i, "import_item_map's CREATE statement must end with ON COMMIT DROP");
  assert.match(sql, /create temporary table pg_temp\.import_collection_map \([^)]*\)\s*on commit drop;/i, "import_collection_map's CREATE statement must end with ON COMMIT DROP");
});
check("D2: the plan_too_large size check appears BEFORE the backup_import_requests INSERT in file order", () => {
  const sql = read0014();
  const sizeCheckIdx = sql.indexOf("return jsonb_build_object('status', 'plan_too_large')");
  const insertIdx = sql.indexOf("insert into public.backup_import_requests (id, user_id) values (p_request_id, v_uid)");
  assert.ok(sizeCheckIdx > 0, "could not locate the plan_too_large return");
  assert.ok(insertIdx > 0, "could not locate the backup_import_requests insert");
  assert.ok(sizeCheckIdx < insertIdx, "plan_too_large check must appear BEFORE the double-submit insert — this is the actual fix for DEFECT 2");
});
check("D3: a per-user advisory lock (pg_advisory_xact_lock keyed on v_uid) is present", () => {
  const sql = read0014();
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\(v_uid::text\)\)/i);
});
check("D4 (behavioral): a rejected oversized plan does NOT consume the request id — a corrected retry with the same id then imports normally", () => {
  const db = makeDb();
  const requestId = "req-oversized";
  const oversizedPlan = { items: Array.from({ length: MAX_LIBRARY_ITEMS + 1 }, (_, i) => ({ backupItemId: `x${i}`, type: "novel", title: "x" })) };
  const r1 = importLibraryBackupModel(db, "user-1", requestId, oversizedPlan);
  assert.deepEqual(r1, { status: "plan_too_large" });
  assert.equal(db.importRequests.has("user-1:req-oversized"), false, "the request id must NOT be consumed by a rejected plan");

  const correctedPlan = { items: [{ backupItemId: "ok", type: "novel", title: "Corrected" }] };
  const r2 = importLibraryBackupModel(db, "user-1", requestId, correctedPlan);
  assert.equal(r2.status, "imported", "the SAME request id, now with a valid plan, must be evaluated normally — not rejected as duplicate_request");
  assert.equal(db.libraryItems.size, 1);
});
check("D5: an oversized plan produces ZERO mutation (no items, no request row) — atomicity for the rejection path too", () => {
  const db = makeDb();
  const oversizedPlan = { collectionsToCreate: Array.from({ length: MAX_COLLECTIONS + 1 }, (_, i) => ({ backupCollectionId: `c${i}`, name: `col${i}` })) };
  const r = importLibraryBackupModel(db, "user-1", "req-oversized-2", oversizedPlan);
  assert.deepEqual(r, { status: "plan_too_large" });
  assert.equal(db.collections.size, 0);
  assert.equal(db.importRequests.size, 0);
});

// ============================================================
// E — concurrency: same plan, different request ids (Issue A / DEFECT 3)
// ============================================================
check("E1: same user, same normalized plan (authoritative catalogSource item), two different request ids run sequentially (modeling the lock's serialization) — the SECOND call must NOT create a duplicate LibraryItem", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "anime", title: "Frieren", catalogSource: { provider: "anilist", externalId: "154587" }, possibleDuplicateOptIn: false }] };
  const r1 = importLibraryBackupModel(db, "user-1", "req-race-1", plan);
  const r2 = importLibraryBackupModel(db, "user-1", "req-race-2", plan);
  assert.equal(r1.status, "imported");
  assert.equal(r2.status, "imported", "the second call is NOT rejected — it just doesn't create a second copy");
  assert.equal(r1.itemsCreated, 1);
  assert.equal(r2.itemsCreated, 0, "the second call must not create a duplicate");
  assert.equal(r2.itemsReused, 1, "the second call remaps to the item the first call already committed");
  assert.equal(db.libraryItems.size, 1, "exactly ONE LibraryItem exists after both calls — no race-created duplicate");
});
check("E2: same guarantee for a TITLE-ONLY match (no catalogSource) — the second call's candidate is skipped, never silently attached, never duplicated", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "novel", title: "Lord of the Mysteries", possibleDuplicateOptIn: false }] };
  const r1 = importLibraryBackupModel(db, "user-1", "req-race-title-1", plan);
  const r2 = importLibraryBackupModel(db, "user-1", "req-race-title-2", plan);
  assert.equal(r1.itemsCreated, 1);
  assert.equal(r2.itemsCreated, 0, "no duplicate created");
  assert.equal(r2.itemsReused, 0, "a title-only match is never silently treated as already-present — it is conservatively skipped, not auto-mapped");
  assert.equal(db.libraryItems.size, 1);
});
check("E3 (A3): an item with possibleDuplicateOptIn=true is NEVER revalidated/remapped, even when an authoritative match exists — the user's explicit choice survives", () => {
  const db = makeDb();
  const authoritative = { items: [{ backupItemId: "b1", type: "anime", title: "Frieren", catalogSource: { provider: "anilist", externalId: "154587" }, possibleDuplicateOptIn: false }] };
  importLibraryBackupModel(db, "user-1", "req-first", authoritative);
  assert.equal(db.libraryItems.size, 1);

  const optIn = { items: [{ backupItemId: "b2", type: "anime", title: "Frieren (different edition)", catalogSource: { provider: "anilist", externalId: "154587" }, possibleDuplicateOptIn: true }] };
  const r2 = importLibraryBackupModel(db, "user-1", "req-optin", optIn);
  assert.equal(r2.status, "imported");
  assert.equal(r2.itemsCreated, 1, "an explicit possible-duplicate opt-in must always create a separate item, never get silently remapped");
  assert.equal(r2.itemsReused, 0);
  assert.equal(db.libraryItems.size, 2, "both the original and the explicitly-opted-in duplicate exist");
});
check("E4: same guarantee for Collections — two concurrent imports racing to create 'the same' new collection by name reuse instead of duplicating", () => {
  const db = makeDb();
  const plan = { collectionsToCreate: [{ backupCollectionId: "c1", name: "Favorites" }] };
  const r1 = importLibraryBackupModel(db, "user-1", "req-col-race-1", plan);
  const r2 = importLibraryBackupModel(db, "user-1", "req-col-race-2", plan);
  assert.equal(r1.collectionsCreated, 1);
  assert.equal(r2.collectionsCreated, 0, "no duplicate collection created");
  assert.equal(r2.collectionsReused, 1);
  assert.equal(db.collections.size, 1, "exactly one collection named Favorites exists");
});
check("E5 (A6): relationships after a race-remap follow existing Stage 29 identity rules — Collection membership attaches to the mapped item, Activity does NOT (was_created=false excludes it, same as any already-present mapping)", () => {
  const db = makeDb();
  const catalogItem = { backupItemId: "b1", type: "anime", title: "Frieren", catalogSource: { provider: "anilist", externalId: "154587" }, possibleDuplicateOptIn: false };
  importLibraryBackupModel(db, "user-1", "req-first", { items: [catalogItem] });

  const racedPlan = {
    items: [catalogItem],
    collectionsToCreate: [{ backupCollectionId: "col1", name: "Watching" }],
    memberships: [{ backupCollectionId: "col1", backupItemId: "b1" }],
    activity: [{ backupItemId: "b1", type: "item_added", timestamp: "2026-01-01T00:00:00.000Z" }],
  };
  const r2 = importLibraryBackupModel(db, "user-1", "req-raced", racedPlan);
  assert.equal(r2.itemsReused, 1);
  assert.equal(r2.activityCreated, 0, "Activity must NOT attach to a race-remapped (was_created=false) item");
  assert.equal(db.collectionItems.length, 1, "Collection membership DOES attach to the remapped existing item — safe, same as any already-present mapping");
});
check("E6 (A7): result counts reflect ACTUAL committed changes, never the stale plan's original expectation", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "anime", title: "Frieren", catalogSource: { provider: "anilist", externalId: "154587" }, possibleDuplicateOptIn: false }] };
  importLibraryBackupModel(db, "user-1", "req-first", plan);
  const r2 = importLibraryBackupModel(db, "user-1", "req-second", plan);
  // The stale plan "expected" 1 item created (it was built before req-first committed); the ACTUAL result must say 0 created, 1 reused.
  assert.equal(r2.itemsCreated, 0);
  assert.equal(r2.itemsReused, 1);
});
check("E7 (later intentional reimport unaffected): revalidation doesn't change the ALREADY-correct behavior of a genuinely separate later reimport", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "novel", title: "Once", catalogSource: { provider: "anilist", externalId: "77" }, possibleDuplicateOptIn: false }] };
  const r1 = importLibraryBackupModel(db, "user-1", "req-day-1", plan);
  assert.equal(r1.itemsCreated, 1);
  // A day later, the user reimports the same file — client-side classification would already say already_present, but even if the client's stale plan still says "create" (e.g. a bug), the server's revalidation independently catches it too, defense in depth.
  const r2 = importLibraryBackupModel(db, "user-1", "req-day-2", plan);
  assert.equal(r2.itemsCreated, 0);
  assert.equal(r2.itemsReused, 1);
  assert.equal(db.libraryItems.size, 1, "no duplicate library, exactly as the pre-existing (non-race) reimport guarantee already promised");
});
check("E8 (cross-account unaffected): the per-user lock/revalidation never applies across accounts — two different users importing the identical plan concurrently both get their own item", () => {
  const db = makeDb();
  const plan = { items: [{ backupItemId: "b1", type: "anime", title: "Frieren", catalogSource: { provider: "anilist", externalId: "154587" }, possibleDuplicateOptIn: false }] };
  const rA = importLibraryBackupModel(db, "user-A", "req-A", plan);
  const rB = importLibraryBackupModel(db, "user-B", "req-B", plan);
  assert.equal(rA.itemsCreated, 1);
  assert.equal(rB.itemsCreated, 1, "User B's identical plan is NOT revalidated against User A's item — different accounts never share identity");
  assert.equal(db.libraryItems.size, 2);
});

// ============================================================
// F — duplicate backup ids reject the whole file (Issue B)
// ============================================================
check("F1: duplicate backupItemId rejects the whole backup — no preview mutation, no import mutation possible", () => {
  const raw = {
    format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
    data: { libraryItems: [
      { backupItemId: "dup", type: "novel", title: "First", createdAt: "2026-01-01T00:00:00.000Z" },
      { backupItemId: "dup", type: "manga", title: "Second", createdAt: "2026-01-01T00:00:00.000Z" },
    ], collections: [], activityEvents: [] },
  };
  const r = validateBackupObject(raw);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "malformed_root");
  assert.equal(r.message, "This backup is damaged or contains invalid data.", "plain-language message, no internal id details exposed");
});
check("F2: duplicate backupCollectionId rejects the whole backup", () => {
  const raw = {
    format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
    data: { libraryItems: [], collections: [
      { backupCollectionId: "dup", name: "First" },
      { backupCollectionId: "dup", name: "Second" },
    ], activityEvents: [] },
  };
  const r = validateBackupObject(raw);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "malformed_root");
});
check("F3: a collection reference cannot ambiguously resolve — the whole file is rejected before any plan/preview is ever built from it", () => {
  const raw = {
    format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
    data: {
      libraryItems: [
        { backupItemId: "dup", type: "novel", title: "First", createdAt: "2026-01-01T00:00:00.000Z" },
        { backupItemId: "dup", type: "manga", title: "Second", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      collections: [{ backupCollectionId: "c1", name: "List", itemIds: ["dup"] }],
      activityEvents: [],
    },
  };
  const r = validateBackupObject(raw);
  assert.equal(r.ok, false, "a Collection referencing an ambiguous (duplicated) backupItemId never gets far enough to resolve anything");
});
check("F4: an Activity reference cannot ambiguously resolve — same whole-file rejection", () => {
  const raw = {
    format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
    data: {
      libraryItems: [
        { backupItemId: "dup", type: "novel", title: "First", createdAt: "2026-01-01T00:00:00.000Z" },
        { backupItemId: "dup", type: "manga", title: "Second", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      collections: [],
      activityEvents: [{ itemId: "dup", type: "item_added", timestamp: "2026-01-01T00:00:00.000Z" }],
    },
  };
  const r = validateBackupObject(raw);
  assert.equal(r.ok, false, "an Activity event referencing an ambiguous (duplicated) backupItemId never gets far enough to resolve anything");
});
check("F5: a backup with NO duplicates (same title, DIFFERENT ids) is unaffected — this is not a title-uniqueness rule, only an id-uniqueness one", () => {
  const raw = {
    format: BACKUP_FORMAT, version: 1, exportedAt: "2026-01-01T00:00:00.000Z",
    data: { libraryItems: [
      { backupItemId: "a", type: "novel", title: "Same Title", createdAt: "2026-01-01T00:00:00.000Z" },
      { backupItemId: "b", type: "novel", title: "Same Title", createdAt: "2026-01-01T00:00:00.000Z" },
    ], collections: [], activityEvents: [] },
  };
  const r = validateBackupObject(raw);
  assert.equal(r.ok, true, "two DIFFERENT ids are never ambiguous, even with identical titles — that's a separate (title-matching) concern, not this structural check");
  assert.equal(r.backup.libraryItems.length, 2);
});

// ============================================================
// Report
// ============================================================
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
  if (!r.ok) console.log(`  ${r.err?.message ?? r.err}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(`\nNote: Tests C/A/E validate the INTENDED ALGORITHM (ownership re-checks, double-submit rejection, server-side Activity idempotency, user-scoped request uniqueness, per-user concurrency revalidation) as a JS model — not a substitute for real PostgreSQL/RLS/locking behavior. Tests D check that 0014's three fixes (ON COMMIT DROP, plan_too_large-before-insert ordering, the advisory lock) are actually present in the deployed file, both statically (source text) and behaviorally (the model). Both 0013 and 0014_stage29_backup_import_fix.sql ARE deployed and have been validated live against the real database — including a genuine concurrent Promise.all reproduction of the same-plan/different-request-id race Test E models (see the Stage 29 live-validation reports): zero race-created duplicate LibraryItems, zero 42P07 across 12+ sequential and 5-way concurrent calls, zero request-id-consumed-by-rejection. Tests F check lib/backup/validate.ts's whole-file duplicate-id rejection.`);
if (failed.length > 0) process.exit(1);
