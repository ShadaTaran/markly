# Markly Backup Format — v1

A portable, versioned JSON contract for a user's Markly library. See the
main README's "Portable Backup, Export & Import (Stage 29)" section for
the full design rationale — this document is a focused schema reference.

## Envelope

```jsonc
{
  "format": "markly-backup",
  "version": 1,
  "exportedAt": "2026-09-05T12:00:00.000Z",
  "backupId": "a-random-id-identifying-this-export-only",
  "data": {
    "libraryItems": [ /* BackupLibraryItem[] */ ],
    "collections": [ /* BackupCollection[] */ ],
    "activityEvents": [ /* BackupActivityEvent[] */ ]
  }
}
```

- `format` and `version` are mandatory and checked first. A missing or
  wrong `format` is rejected as "Not a Markly backup." A `version` newer
  than this app supports is rejected as unsupported — future versions may
  add fields, never silently reinterpret existing ones.
- `backupId` identifies this one export instance for display/debugging
  only. It is never treated as proof that a record was previously
  imported, and it is never the sole mechanism preventing duplicate
  import — see "Idempotency" below.
- `exportedAt` must be a valid ISO 8601 timestamp.

## `BackupLibraryItem`

```ts
{
  backupItemId: string;      // unique within this file only — never a database id
  type: "website" | "anime" | "manga" | "novel" | "game" | "movie" | "series";
  title: string;
  description: string;
  category: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;         // ISO date, preserved exactly
  updatedAt?: string;

  url?: string;               // website only
  imageUrl?: string;
  sourceUrl?: string;
  releaseYear?: number;
  catalogSource?: { provider: "anilist" | "open-library" | "tmdb" | "rawg"; externalId: string };
  status?: "planned" | "in_progress" | "completed" | "on_hold" | "dropped";
  rating?: number;            // 1-10, half-point steps

  // anime/series
  currentEpisode?: number;
  totalEpisodes?: number;
  episodeNumbering?: "absolute" | "seasonal";
  currentSeason?: number;
  genres?: string[];
  studio?: string;            // anime only

  // manga
  currentChapter?: number;
  totalChapters?: number;
  authors?: string[];         // manga, novel

  // novel
  progressValue?: number;
  progressUnit?: "chapter" | "page" | "percent";
  pageCount?: number;
  readingFormat?: "book" | "light_novel" | "web_novel";

  // game
  platform?: string;
  playtimeHours?: number;
  developer?: string;
  publisher?: string;
  catalogPlatforms?: string[];
}
```

Never present: `id` (database primary key), `user_id`/any ownership
field, `anilistSync` (account-connection-relative sync bookkeeping — see
README for why this is excluded even though `catalogSource` is kept).

## `BackupCollection`

```ts
{
  backupCollectionId: string;
  name: string;
  description?: string;
  createdAt: string;
  itemIds: string[]; // BackupLibraryItem.backupItemId references, not database ids
}
```

## `BackupActivityEvent`

A discriminated union mirroring the app's own `ActivityEvent` type minus
its own internal `id` (never preserved — purely internal, not portable):

```ts
{ itemId: string; timestamp: string; type: "item_added" }
| { itemId: string; timestamp: string; type: "progress_updated";
    progressKind: "episode"|"chapter"|"page"|"percent"|"playtime"|"season_episode";
    previousValue?: number; newValue: number; previousSeason?: number; newSeason?: number }
| { itemId: string; timestamp: string; type: "rating_updated";
    previousValue?: number; newValue?: number }
| { itemId: string; timestamp: string; type: "status_updated";
    previousValue?: "planned"|"in_progress"|"completed"|"on_hold"|"dropped";
    newValue: "planned"|"in_progress"|"completed"|"on_hold"|"dropped" }
```

`itemId` references a `BackupLibraryItem.backupItemId`, never a database
id. `timestamp` is preserved exactly — a malformed timestamp causes that
one event to be dropped, never replaced with "now."

## Explicitly excluded from every version of this format

TrackingSources, extension device/pairing credentials, AniList/OAuth
connection records (`external_connections`), Stage 28 recovery actions,
and any authentication/session data. None of these have a field to
occupy in this schema — their absence is structural, not a validation
rule that could be bypassed.

## Import semantics (summary — see README for the full design)

- **Never automatic merging.** An item is only ever created as new or
  recognized as already present (by `catalogSource` or, for websites,
  exact URL); a title-only match is a "possible duplicate," skipped by
  default, and even when included is created as a separate item.
- **Never overwrites existing data.** An "already present" match is
  never written to — only its Collection membership may be attached.
- **Collections** reuse an existing collection by exact (trimmed,
  case-insensitive) name; otherwise create a new one.
- **Activity** is only ever imported for genuinely new items — this
  (not a provenance table) is what keeps importing the same backup twice
  from duplicating history.
- **Idempotency**: reimporting the same file reclassifies previously-
  imported items as "already present" automatically; a `backupId`
  matching a prior import is never checked or relied upon for this.

## Limits (v1)

15 MB file size · 5,000 LibraryItems · 200 Collections · 50,000 Activity
events. A file over any hard limit is rejected outright before detailed
per-record validation runs.

## Backup-local id uniqueness

`backupItemId` and `backupCollectionId` define this file's graph
identity — Collections and Activity reference items only by
`backupItemId`, and memberships reference collections only by
`backupCollectionId`. Two records claiming the same id makes any
reference to it structurally ambiguous, so a duplicate `backupItemId` or
`backupCollectionId` anywhere in the file rejects the WHOLE backup before
any preview or mutation — never resolved by silently keeping one
occurrence and dropping the other.
