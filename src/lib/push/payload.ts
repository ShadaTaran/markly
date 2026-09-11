/**
 * Stage 37 — the versioned, minimal Web Push payload contract (§7/§8/§53).
 * Pure and side-effect-free: builds what the server sends, and validates
 * what the service worker receives. The service worker itself
 * (public/sw.js) is plain vanilla JS with no build step (Stage 37 §5 — the
 * smallest dedicated worker, not a bundled app) and therefore cannot
 * `import` this module, so its own copy of `isSupportedNotificationRoute`/
 * the payload shape is a deliberate, documented, verbatim reproduction —
 * the same cross-boundary duplication convention every verify-*.mjs script
 * in this repo already uses for pure TS logic (see e.g.
 * scripts/verify-command-palette.mjs's own header comment). Kept
 * deliberately tiny so that duplication stays cheap to keep in sync;
 * scripts/verify-web-push.mjs statically checks both copies agree.
 *
 * Deliberately excludes (§7): item description/notes, tags, full source
 * URL, tracking-source data, AniList fields beyond a title. A route is
 * always a typed, server-built object — never a raw href straight from
 * data (§8/§23), so the service worker can never be made to navigate
 * anywhere outside this fixed allowlist.
 */

export const NOTIFICATION_PAYLOAD_VERSION = 1;

export type NotificationRoute = { type: "reminders" } | { type: "library-item"; itemId: string };

export type NotificationKind = "reminder" | "test";

export interface NotificationPayload {
  version: 1;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Stage 37 §54 — occurrence-specific (or a fixed "test" tag), never one global tag that would replace every distinct reminder's notification. */
  tag: string;
  route: NotificationRoute;
}

const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 140;
const MAX_TAG_LENGTH = 200;
const MAX_ITEM_ID_LENGTH = 200;

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** The one place that decides which route shapes a push payload may ever carry — extend this (and the sw.js copy) deliberately, never accept an arbitrary shape. */
export function isSupportedNotificationRoute(value: unknown): value is NotificationRoute {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "reminders") return true;
  if (record.type === "library-item") return isNonEmptyBoundedString(record.itemId, MAX_ITEM_ID_LENGTH);
  return false;
}

/** Defensive parse for whatever a push event actually delivered — untrusted (Stage 37 §52) even though this server is the only real sender, since a payload can be replayed, truncated, or (in principle) forged by anything that learns the endpoint. Returns null on anything malformed; callers must fall back to a safe generic notification rather than throw. */
export function parseNotificationPayload(data: unknown): NotificationPayload | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.version !== NOTIFICATION_PAYLOAD_VERSION) return null;
  if (record.kind !== "reminder" && record.kind !== "test") return null;
  if (!isNonEmptyBoundedString(record.title, MAX_TITLE_LENGTH)) return null;
  if (!isNonEmptyBoundedString(record.body, MAX_BODY_LENGTH)) return null;
  if (!isNonEmptyBoundedString(record.tag, MAX_TAG_LENGTH)) return null;
  if (!isSupportedNotificationRoute(record.route)) return null;
  return {
    version: NOTIFICATION_PAYLOAD_VERSION,
    kind: record.kind,
    title: record.title,
    body: record.body,
    tag: record.tag,
    route: record.route,
  };
}

export interface ReminderNotificationInput {
  reminderId: string;
  occurrenceVersion: string;
  libraryItemId: string;
  /** Stage 37 §7 evaluation: including the item's OWN title (never a description/note/tag) reads as clearly more useful than a bare "A saved reminder is due," and it is only ever the requesting user's own reminder/item title — never another user's data, never metadata pulled from a TrackingSource or AniList beyond what the item record itself already stores. Still deliberately excluded: episode/chapter numbers, source hostnames, ratings, notes. */
  itemTitle: string;
}

/** Builds the real payload for a due reminder (Stage 37 §7/§54) — title-inclusive, per the tradeoff documented above. `tag` is occurrence-specific (reminder id + version), so the OS can dedupe a redelivered/retried push for the exact same occurrence without ever colliding with a different reminder's notification. */
export function buildReminderNotificationPayload(input: ReminderNotificationInput): NotificationPayload {
  return {
    version: NOTIFICATION_PAYLOAD_VERSION,
    kind: "reminder",
    title: "Markly reminder",
    body: truncate(input.itemTitle, MAX_BODY_LENGTH),
    tag: `markly-reminder-${input.reminderId}-${input.occurrenceVersion}`,
    route: { type: "library-item", itemId: input.libraryItemId },
  };
}

/** Stage 37 §22 — distinguishable from a real reminder delivery both by `kind` and by a fixed, non-occurrence tag (repeated test sends intentionally replace each other, never stack up). */
export function buildTestNotificationPayload(): NotificationPayload {
  return {
    version: NOTIFICATION_PAYLOAD_VERSION,
    kind: "test",
    title: "Markly test notification",
    body: "Background notifications are working on this browser.",
    tag: "markly-test-notification",
    route: { type: "reminders" },
  };
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed || "A saved reminder is due.";
}
