# Markly

Markly is a responsive bookmark manager built with Next.js and TypeScript. It provides a clean way to save, organize, search, filter, and favorite useful websites, with browser-based persistence and light/dark theme support.

<!-- Add a screenshot here, e.g. ![Markly screenshot](./screenshot.png) -->

## Features

- Add, edit, and delete bookmarks, each with a title, URL, description, category, and tags
- Full-text search across bookmark titles, URLs, descriptions, categories, and tags
- Favorites, with a dedicated filter
- Dynamic categories derived from your bookmarks (no fixed list), with normalization so casing/whitespace differences don't create near-duplicate categories
- Click-to-filter tags, with a clearable active-tag indicator
- Sorting by newest, oldest, title A–Z, or title Z–A
- Combined filtering — search, category/favorites, and tag filters all apply together
- Persistent storage via the browser's `localStorage` by default, including safe handling of missing or malformed stored data
- Optional account sign-up/sign-in (email/password) for cross-device sync — entirely opt-in; Markly works fully without an account
- Optional AniList connection (account mode only) to import and manually sync your Anime/Manga tracking — see "Connected Accounts" below
- Optional browser extension (account mode only) that automatically advances progress on supported reading pages — see "Auto Tracking" below
- Light and dark themes that respect the system preference on first visit, with the choice remembered afterward
- Responsive layout for desktop, tablet, and mobile

## Tech Stack

- [Next.js](https://nextjs.org/) (App Router)
- [React](https://react.dev/)
- [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Supabase](https://supabase.com/) (Auth + Postgres) — optional; only used when an account is configured and signed into

Markly is local-first: with no Supabase project configured, it runs entirely client-side against `localStorage`, no backend required. Configuring Supabase adds optional accounts and cross-device sync on top of that same local-first experience.

## Getting Started

Prerequisites: Node.js 20.9 or later.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Build

```bash
npm run build
npm start
```

`npm run build` also type-checks the project as part of the Next.js build. A standalone type check is available separately:

```bash
npm run typecheck
```

## Data Persistence

Markly has two modes:

**Local mode (default, no account needed).** Your library, collections, and activity history live in the browser's `localStorage` (`markly.library`, `markly.collections`, `markly.activity`), and the theme choice lives separately under `markly.theme`. Data is stored per browser, per device — clearing site data removes it, and a different browser/device starts fresh.

**Account mode (optional, requires Supabase).** Signing in switches the same library/collections/activity views to a Supabase-backed store, isolated per user via Postgres Row Level Security — nothing is shared between accounts, and the database only ever sees what the signed-in user owns. Signing out returns to local mode; local mode's data is never deleted or overwritten by signing in or out.

**Bringing existing local data into an account.** The first time you sign in on a browser that already has local data, Markly offers to import it (once) into your account. Import is safe to repeat — it never creates duplicates, and your original local data is left in place afterward as a backup, not deleted.

Theme is always local-only (`markly.theme`), regardless of sign-in state.

## Environment Variables

Supabase is optional. With none of the variables below set, Markly runs entirely in local mode — every feature works, "Sign In" simply explains that cloud sync isn't configured.

To enable accounts and cross-device sync:

1. Create a project at [supabase.com](https://supabase.com/).
2. Run the SQL in [`supabase/migrations/0001_stage16_core_schema.sql`](./supabase/migrations/0001_stage16_core_schema.sql) against it (Supabase Dashboard → SQL Editor, or `supabase db push` if you use the Supabase CLI). It creates the `library_items`, `collections`, `collection_items`, and `activity_events` tables with Row Level Security enabled, and is safe to re-run.
3. Copy `.env.example` to `.env.local` and fill in your project's URL and anon (public) key, found under Project Settings → API:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

Both are safe for client-side code — the anon key relies on Row Level Security, not secrecy, to protect data. Never put a Supabase **Secret API Key** (or its legacy service-role equivalent) in `NEXT_PUBLIC_SUPABASE_ANON_KEY` or anywhere client-reachable — the one legitimate use of a Secret API Key in this project (`SUPABASE_SECRET_KEY`, for the browser extension's device-authenticated API) is documented in "Auto Tracking" below and lives only in `src/lib/supabase/admin.ts`.

Metadata search also has its own optional, server-only API keys (`TMDB_API_KEY`, `RAWG_API_KEY`) — see the comments in `.env.example`.

## Metadata Search

Adding anime/manga/novel/movie/series/game items offers a catalog search step before the manual entry form (`src/components/MetadataSearchPanel.tsx`), backed by a per-type provider (`src/lib/metadata/registry.ts`): AniList for anime/manga, TMDB for movies/series, RAWG for games, and — for **Books & Novels** (`mediaType: "novel"` internally; the user-facing label changed from "Novel / Book" purely as copy, nothing persisted changed) — two catalogs queried in parallel and merged into one result list (`src/lib/metadata/providers/combined-novel.ts`):

- **Open Library** — traditionally-published books (unchanged from earlier stages).
- **AniList** (`format: NOVEL`/`ONE_SHOT` on its manga catalog) — officially-published **light novels**.

Each result shows which catalog it came from, and the footer attribution updates to reflect whichever source(s) actually contributed to what's on screen. **Honest scope:** this expands coverage for licensed light novels, not raw/fan-translated web novels in general — AniList's NOVEL-format catalog has no entry at all for many hugely popular web novels that were never formally published as a book (verified directly against the live API: searching "Reverend Insanity" or "The Perfect Run" returns zero NOVEL-format results, only their unrelated manga/manhua adaptations if any exist). There is no public, unauthenticated, ToS-compliant catalog API for that case today — NovelUpdates, the closest thing to a web-novel directory, has no public API and disallows scraping, and this project won't build around bypassing that. For that case, Markly leans on what it already knows from the browser extension detection instead — see "Add or Link" below.

### Reading format

A novel's publication format is a separate, optional concept from its tracking media type — `mediaType` stays `"novel"` for every kind of written prose; `readingFormat` (`"book" | "light_novel" | "web_novel"`, `src/types/library-item.ts`) is a sparse, JSONB-backed metadata field (same storage pattern as `authors`/`pageCount` — no migration needed) that just describes *what kind* of novel it is. It's inferred conservatively, never asserted where there's no real signal for it: an Open Library result infers `"book"`, an AniList light-novel result infers `"light_novel"` (`inferReadingFormatFromCatalog`, `src/lib/metadata/catalog-item.ts`), and a browser-detected work with no catalog match *suggests* `"web_novel"` (never presented as verified fact) — always visible and editable via the Format field on the full item form, never locked in.

### Add or Link

Settings → Auto Tracking's picker for a detected-but-unlinked tracking source has three ways to resolve it:

1. **Pick from your existing library** — the original Stage 18 inline picker, untouched.
2. **Search the catalog** for richer metadata — opens the same search-and-add flow "Add Item" uses (`LibraryItemDialog`), pre-filled with the detected title and media type. Selecting a result creates a catalog-backed LibraryItem *and* carries the detected progress into it (so picking the right Mushoku Tensei light novel while on chapter 40 creates the item already at chapter 40 / Reading, not blank/Planned) — see `initialTrackingForAdd` in `LibraryItemDialog.tsx`.
3. **Add the detected work directly** — a persistent "Detected from your reading" card (title, source origin, detected progress) with **Add & Track** (creates the item at the detected progress/status and links it immediately, no form) or **Edit Details** (the same data, reviewable/editable first via the full item form) — see `src/lib/extension/detected-item.ts` and `MetadataSearchPanel`'s `detectedFallback`.

**The detected work is never gated behind catalog search failing.** An earlier version of this only showed it when the catalog returned zero results or errored — which meant it silently vanished the moment a provider returned *any* result, however irrelevant (real bug: searching a raw web novel like "Lord of the Mysteries" made Open Library return unrelated mystery novels — *Whose Body?*, *Lord Edgware Dies*, *Gaudy Night* — which counted as "results" and hid the detected-work option entirely). The detected-work card is now rendered unconditionally whenever `detectedFallback` is set, positioned above the catalog section and structurally independent of whatever state that search is in — present during loading, on zero results, on a provider error, and alongside ten irrelevant results alike. The plain "Add Item" flow (no `detectedFallback`) is unaffected and shows no such card.

**Catalog relevance ranking** (`src/lib/metadata/relevance.ts`, `calculateTitleRelevance`/`partitionByRelevance`) keeps a provider's fuzzy free-text search from presenting an unrelated result as a likely match: deterministic string comparison only (no AI/LLM) sorts results into `exact` (identical, or differing only by a trailing "Vol. 1"/"Book 2" marker — so legitimate volume variants are never over-filtered), `close` (one title's significant words are an ordered prefix of the other's, or they share enough vocabulary — handles a missing article or an added subtitle), and `unrelated` (little to no real word overlap, including a deliberately-tested false-positive trap: two titles sharing only common English words like "the perfect run" vs. "how to run a perfect business" still correctly resolve to `unrelated`). `exact`/`close` results are shown normally, ranked exact-first; `unrelated` results are collapsed behind a "Show N more results" toggle rather than hidden outright. **This ranking exists purely for what `MetadataSearchPanel` displays** — Smart Auto-Link (`src/lib/extension/auto-link.ts`) has its own separate, untouched, exact-match-only comparison and was not loosened by any of this.

All creation paths funnel through one shared `createAndLinkItem` in `TrackingSettingsPanel.tsx`: create the LibraryItem, **await** its cloud persistence, *then* link the tracking source — never the reverse, which would race the source's RLS ownership check against a row that doesn't exist yet. Exactly one `item_added` Activity event is recorded per creation (the item's starting progress is not a "transition" — there's no prior value to diff against — so no `progress_updated` event is generated for it, matching how a plain "Add Item" never logs one either). Once linked, `tracking_sources.library_item_id` is used directly on every later detection — title matching never runs again for that source.

## Connected Accounts (AniList)

Signed-in account-mode users can optionally connect an [AniList](https://anilist.co/) account to import and manually sync their Anime/Manga tracking into Markly. This is entirely separate from Markly's own account system — it's an AniList-specific integration, requires you to already be signed into Markly, and only ever writes into *your own* Markly library.

**What it does today:**

- **AniList → Markly only.** Connecting and syncing never writes anything back to your AniList account. Markly reads your AniList lists; it never calls AniList's list-mutation API.
- **First import is opt-in and previewed.** After connecting, Markly shows how many Anime/Manga entries it found before importing anything — nothing is pulled in automatically.
- **Manual "Sync Now" only.** There is no background sync, polling, or webhook. You decide when to pull newer AniList state into Markly.
- **Matching is by AniList media ID**, reusing the same `catalogSource` reference Markly's existing AniList search/autofill already stores — an item added via search and later found in your AniList list is recognized as the same item, never duplicated.
- **Conflicts are surfaced, not guessed.** If both Markly and AniList have changed a tracked value since the last sync, Markly shows you both values and lets you pick, rather than silently picking a "newest wins" side.
- **REPEATING lists (rewatching/rereading)** map to Markly's `in_progress` status — Markly has no separate "rewatching" status yet, so this is a deliberate simplification, not a full mapping. The original AniList status is retained internally so this can be revisited later without re-importing.
- **Manga chapter decimals are protected.** Markly allows split-release chapter numbers (e.g. `12.5`); AniList's progress is always a whole number. If your Markly progress has a fractional part and AniList disagrees, Markly treats it as a conflict for you to resolve rather than silently rounding it away.
- **Personal AniList scores** are requested in AniList's `POINT_10_DECIMAL` format (0–10 with one decimal) regardless of your AniList account's configured scoring style, then rounded to Markly's nearest half-point. AniList's "no score" (0) maps to Markly's "Unrated," never to a literal 0.

**Setting up an AniList developer application (required to use this feature):**

1. Sign into AniList and open [Developer Settings](https://anilist.co/settings/developer).
2. Create a new API client.
3. Set its redirect URL to exactly:
   ```
   http://localhost:3000/api/integrations/anilist/callback
   ```
   (or your deployed origin's equivalent — it must match `ANILIST_REDIRECT_URI` exactly, including protocol and trailing-slash-or-not).
4. Copy the generated Client ID and Client Secret into `.env.local`:
   ```bash
   ANILIST_CLIENT_ID=
   ANILIST_CLIENT_SECRET=
   ANILIST_REDIRECT_URI=http://localhost:3000/api/integrations/anilist/callback
   ```
5. Generate a token-encryption key and set it too:
   ```bash
   openssl rand -base64 32
   ```
   ```bash
   MARKLY_INTEGRATION_ENCRYPTION_KEY=<paste the output above>
   ```
6. Run [`supabase/migrations/0002_stage17_external_connections.sql`](./supabase/migrations/0002_stage17_external_connections.sql) against your Supabase project (after `0001_stage16_core_schema.sql`).

**Token handling.** AniList currently issues no refresh tokens — access tokens are long-lived (about a year) but eventually expire, at which point Markly shows "Reconnect required" rather than silently failing or deleting anything. Your AniList access token is encrypted (AES-256-GCM, a server-only key) before it's stored, is never sent to the browser in any form, and every AniList API call happens server-side. Disconnecting removes Markly's stored copy of the token; AniList itself exposes no revocation endpoint for Markly to call, so disconnecting is a local action, not an AniList-side revocation. Imported library items, collections, and activity history are never deleted by disconnecting.

**Where to find it:** once signed in, open the account menu (top right) → **Connections**, or go directly to `/settings/connections`.

## Auto Tracking (Browser Extension)

Signed-in account-mode users can optionally connect the **Markly Auto Tracking** browser extension (Chrome/Chromium, Manifest V3, in [`extension/`](./extension)) to automatically advance a LibraryItem's progress when they navigate a supported reading page — no manual "+1" needed. Stage 18 builds the full pipeline and proves it end-to-end with two controlled Markly test pages; it does **not** yet include a real external-site adapter (that's Stage 19).

### Architecture

```
page within tracked scope (host_permissions)
  → content script injected
  → does a registered adapter's matches(url) claim this URL?
      yes → that adapter's detect() result, exclusively (even if null)
      no  → universal detection engine (extension/src/tracking/universal/)
  → normalized detection { adapterId, sourceKey, sourceTitle, mediaType, progress }
  → extension service worker
  → POST /api/extension/progress  (Authorization: Bearer <device token>)
  → tracking_sources mapping lookup
  → LibraryItem progress update (advance-only)
  → Activity history
```

**Universal detection is the default; adapters are overrides.** A site doesn't need a dedicated adapter to be auto-tracked — the universal engine tries first, on any page in scope. An adapter only takes over for a URL its own `matches()` claims, which happens when a site's markup is unreliable for generic heuristics; when one does claim the URL, its result is used exclusively (a confident universal guess never overrides an adapter that decided "no", since the adapter exists specifically because generic detection was wrong there). This is decided *inside* the content script — the service worker's injection gate (`isWithinTrackedScope`, tied to `host_permissions`) only decides whether to run at all, never which detector runs, so universal coverage never requires broader permissions than an adapter would have needed for the same site.

**Universal detection signals**, each independently weighted and combined (`extension/src/tracking/universal/confidence.ts`):

| Signal | Weight | Source |
| --- | --- | --- |
| URL path pattern | 35 | `/chapter-234`, `/ch-234`, `/c234`, `/episode-12`, `/ep-12`, `/e12`, etc. |
| Heading text | 30 | First `h1`/`h2` matching "Chapter N" / "Episode N" |
| Document title | 20 | `document.title`, e.g. "Lord of Mysteries - Chapter 234" |
| Structured metadata | 15 | `og:title`, JSON-LD `name` |
| Navigation (bonus only) | +20 | Previous/Next link targets adjacent to the leading value |

Signals are grouped by the numeric value they each independently arrive at (a page can have several candidate numbers — a chapter count and a view count, say). The value with the most combined weight wins, but a detection only fires if **at least two signals agree on that value** *and* the combined score clears a threshold (55) — a single strong signal is never enough by itself, on purpose: a URL like `/chapter-234` alone, or a page that only says "Views: 234000" with nothing else numeric nearby, both correctly detect nothing rather than guess. Navigation can only add weight to a value some other signal already established; it can never establish one on its own. This whole design follows directly from one rule: **a wrong automatic update is worse than a missed one.**

**Source identity** for a universal detection is derived the same way as for an adapter — a stable key independent of the current chapter's URL (the URL with its matched progress segment stripped, or `hostname::slugified-title` when no URL pattern matched), never the literal page URL. Universal detections use the fixed adapter id `universal-reader` and go through the exact same "Source mapping" linking flow below — a confident universal detection still returns `needs_link` on first sight, same as an adapter's.

### Setup

1. Run [`supabase/migrations/0003_stage18_auto_tracking.sql`](./supabase/migrations/0003_stage18_auto_tracking.sql) against your Supabase project (after `0001` and `0002`). It adds `extension_devices`, `pairing_codes`, and `tracking_sources`, all with Row Level Security. Then run [`supabase/migrations/0004_stage18_atomic_progress.sql`](./supabase/migrations/0004_stage18_atomic_progress.sql), which adds the `apply_extension_progress` function auto-tracking's write path depends on for concurrency safety (see "Progress safety" below) — required for `/api/extension/progress` to work at all, not optional.
2. Add a Supabase **Secret API Key** to `.env.local`:
   ```bash
   SUPABASE_SECRET_KEY=
   ```
   Find it under your Supabase project's Settings → API Keys → Secret keys — the current replacement for the legacy `service_role` JWT (older projects that only have a `service_role` key can set `SUPABASE_SERVICE_ROLE_KEY` instead; it's read as a fallback, but `SUPABASE_SECRET_KEY` is the recommended configuration going forward). This is required specifically because the extension authenticates with its own device token, not a Supabase session, so there's no `auth.uid()` for Row Level Security to check — see "Why a Secret API Key" below for the full reasoning and the safeguards around it.
3. Build the extension:
   ```bash
   npm run extension:build
   ```
   This produces `extension/dist/` (manifest, service worker, content script, popup — gitignored, rebuilt from source). Use `npm run extension:watch` while developing.
4. Load it in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist`.
5. With `npm run dev` running and you signed into Markly at `http://localhost:3000`, open the extension popup and follow the pairing flow below.

### Pairing (how the extension authenticates)

The extension is **not** a Supabase user — it never receives a Supabase session, an AniList token, or any server secret. Instead:

1. In Markly, go to **Settings → Auto Tracking** and click **Connect Extension**. This generates a random, one-time pairing code (e.g. `K7JP-4M82-QRXT`, 12 characters from a 32-symbol unambiguous alphabet — 60 bits of entropy) that expires in about 10 minutes; only its hash is stored server-side, and hyphens are cosmetic — the extension popup accepts the code with or without them.
2. Enter that code into the extension popup. The extension calls `POST /api/extension/pair`, which atomically consumes the code (so it can never be reused, even by two near-simultaneous attempts) and mints a fresh, high-entropy device token. The route also applies a simple in-memory, per-IP rate limit (10 attempts/minute) as defense-in-depth — see "Pairing code security" below for why the code's own entropy, not this limiter, is what actually makes brute-forcing infeasible.
3. The extension stores that raw token only in `chrome.storage.local`, restricted to trusted extension contexts (`setAccessLevel("TRUSTED_CONTEXTS")`) — the content script never receives it, and it never touches webpage `localStorage`. Markly's database stores only a SHA-256 hash of it, never the raw value.
4. Every later request to `/api/extension/progress` authenticates with `Authorization: Bearer <token>`; the server hashes it, looks up the owning user, and derives `user_id` **only** from that lookup — a request body can never claim to be a different user.

### Pairing code security

The pairing code is the only credential an unauthenticated party could try to guess, so its entropy is the actual defense (rate limiting below is a second layer, not the primary one). It's drawn from `crypto.randomBytes` (cryptographically random, not `Math.random`) over a 32-symbol alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `0`/`O`/`1`/`I`, to avoid characters that are easy to misread when typing one in by hand); 32 divides 256 evenly, so `byte % 32` introduces no modulo bias. At 12 symbols that's 12 × log2(32) = **60 bits** of entropy — even at a generous 100 guesses/second sustained for the entire ~10-minute validity window, that's under 2^17 attempts against a 2^60 space, i.e. astronomically infeasible. On top of that, `/api/extension/pair` applies a simple in-memory, per-process, per-IP fixed-window rate limit (`src/lib/extension/rate-limit.ts`, 10 attempts/minute) — deliberately not a distributed solution (no Redis or similar), since it resets on restart and is scoped per server instance under horizontal scaling; that tradeoff is acceptable here specifically *because* the code's entropy already makes brute-forcing impractical without it. Codes are one-time (an atomic `UPDATE ... WHERE used_at IS NULL` makes double-redemption impossible even under a race), stored only as a SHA-256 hash, and expire in 10 minutes.

### Why a Secret API Key

Every other Markly API route authenticates via the user's normal Supabase session (cookies), which Row Level Security checks against automatically. The extension has no such session. The two extension-facing routes (`/api/extension/pair`, `/api/extension/progress`) therefore use a server-only admin client (`src/lib/supabase/admin.ts`, gated behind the `server-only` package so importing it from a Client Component is a build error) that bypasses RLS — but only after independently verifying a pairing code or device token, and every query it makes is still manually scoped to the `user_id` that verification produced. The key (`SUPABASE_SECRET_KEY`, falling back to the legacy `SUPABASE_SERVICE_ROLE_KEY` if that's what a project still issues) is never sent to the browser or the extension, never returned by any API response, never logged, and every other route in the app continues to use the ordinary session-based client with RLS enforced normally.

### Source mapping — smart auto-linking, manual linking as the fallback

Every detected work gets a persistent `tracking_sources` row keyed by `(adapter, stable source key)` — for the test adapter, `lord-of-mysteries`, not the current chapter's URL (which changes every chapter). The extension never guesses casually, but it also doesn't force manual linking for the common case: on a source's *first* detection (no `tracking_sources` mapping yet), `/api/extension/progress` tries a smart auto-link (`src/lib/extension/auto-link.ts`) before falling back to manual linking. It only links automatically when the match is unambiguous:

1. **Exact normalized title + compatible media type, requiring exactly one match.** "Lord of Mysteries" only auto-links to a Novel LibraryItem titled "Lord of Mysteries" (case/whitespace/quote-style differences are normalized away — see `normalizeTitleForMatching`) — never to an Anime item with the same title, and never if two Novel items in your library share that title (that's `needs_link`, not a coin flip). No fuzzy matching is ever used for an automatic link — a near-miss title is a manual-linking decision, not an automatic one.
2. Two stronger tiers — an authoritative catalog/external identifier shared by both the source and a LibraryItem, and corroborating structured metadata (e.g. an author) — are reserved ahead of title matching for future detectors that expose them; no current adapter or the universal engine does yet, so only the title tier is active today.

A successful auto-link creates the `tracking_sources → library_item_id` mapping and immediately applies the just-detected progress in the same request (the response includes `autoLinked: true` on that one request only). Once a mapping exists — whether from auto-linking or the manual picker — it's used directly on every later detection; title matching never runs again for that source, and it isn't re-run for a source that's still unlinked from before this feature existed either, except that its *next* detection now gets the same auto-link attempt a brand-new source would.

If matching is ambiguous or nothing matches, the source is recorded but stays unlinked — the API returns `needs_link` (with `reason: "ambiguous"` or `reason: "no_match"`) and nothing in your library changes. Manual linking (Settings → Auto Tracking → **Link Item**, restricted to compatible types — a Novel source still can't be linked to an Anime item) remains the fallback for exactly these cases, plus correcting a wrong auto-link or an unusual site the title-matching heuristic doesn't suit. Sources can still be unlinked at any time from the same settings page.

### Progress safety

Auto-tracking only ever **advances** progress. If Markly already shows Chapter 300 and the extension detects Chapter 50 (e.g. you're rereading an old chapter), Markly is left at 300 — auto-tracking never moves progress backward.

A successful automatic advance creates a normal `progress_updated` (and `status_updated`, if it also advanced planned → in_progress) Activity event tagged as tracked automatically — visible in Recent Activity the same restrained way AniList sync events are, never one event per DOM mutation.

**Concurrency is handled database-side, not by trusting a single request.** `/api/extension/progress` reads, compares, writes, and inserts Activity rows inside one call to a Postgres function, `apply_extension_progress` (`supabase/migrations/0004_stage18_atomic_progress.sql`), which locks the target LibraryItem row (`select ... for update`) before comparing anything. If 2, 10, or 20 identical detections arrive at nearly the same time — the extension retrying, a duplicate racing a fresh detection, or requests landing on different server instances — only the one that actually observes and wins the compare-and-set writes anything; every other concurrent request blocks briefly, then sees the already-updated value and returns `unchanged` having inserted zero Activity rows. The extension's own dedup (`lastSentValue` in `background/service-worker.ts`, skipping a re-send of a value already sent) is a network-efficiency optimization on top of this, not what makes duplicate writes impossible — that guarantee is the database function's alone, and holds even if the extension-side dedup were removed entirely.

### Permissions and privacy

The extension requests `storage` (device token + per-tab status), `scripting` (content-script injection), and `activeTab` (lets the popup see the current tab's URL when opened, so it can offer "Enable Tracking" — a silent permission with no install-time warning), plus `host_permissions` for `http://localhost:3000/*` (the Markly dev/test origin, always in scope). It does **not** request `<all_urls>`, `cookies`, `webRequest`, or `tabs`. Every other site is opt-in, one origin at a time: `manifest.json` declares a wildcard scheme-and-host pattern under `optional_host_permissions` — this doesn't grant access to anything by itself, it only lists what *can later be requested* — and the extension only ever calls `chrome.permissions.request()` for one concrete origin, only from inside a genuine click on the popup's "Enable Tracking" button (see [extension/README.md § Runtime site permissions](./extension/README.md#runtime-site-permissions)). Enabling NovelPhoenix never grants access to any other site, and a user can review or revoke any granted site at any time from the extension's options page.

Regardless of which sites are enabled, the extension does not read passwords or login forms, does not send full page HTML or unrelated page content to Markly (only h1/h2 text, title, a handful of metadata tags, and prev/next link hrefs are ever inspected), does not collect general browsing history, does not run on any page outside its granted scope, and does not sell or share browsing data with anyone — Markly's own servers are the only destination for any detection it sends, ever, and even that only happens for a *confident* detection (a low-confidence result stays local to the popup, never reaching the API). Universal detection does not change any of this: it only changes *which* pages within an already-granted origin get tracked, never *how many* origins the extension can reach.

### Real-site validation (Stage 19)

The first real target, [NovelPhoenix](https://novelphoenix.com), works entirely through `universal-reader` — **no dedicated adapter was created.** Verified live across 3 chapter URLs and 2 novels (stable source identity across chapters, correct title/chapter extraction, correct Next Chapter progression). Only the `markly-test-reader` adapter exists beyond that, matching Markly's own controlled test page at `/dev/reader-test` (development/testing only, not a real feature) — a second test page, `/dev/reader-test-generic`, deliberately uses ordinary reader-style markup with none of the first page's Markly-specific attributes, proving universal detection doesn't secretly depend on either. See [extension/README.md § Real-world title shapes](./extension/README.md#real-world-title-shapes) for the generic engine improvements that real-site testing turned up. A site-specific adapter (`extension/src/adapters/your-site.ts`, same `matches()`/`detect()` interface) remains available for a future site where universal detection genuinely proves unreliable.

### Metadata Enrichment (Stage 21)

A detected-work item created via "Add or Link" (above) starts out with only what the extension could always see — title, media type, progress. Metadata enrichment fills in cover, author(s), description, and a stable work URL from the same *safe, structured* signals the universal engine already reads for detection, never from chapter/body text. **Tracking never depends on this succeeding** — a page with none of these signals produces exactly the same sparse item Stage 20 always did; enrichment is additive, best-effort, and silent.

**Signals read, and only these:** `og:title`, `og:image`, `og:description`/`meta[name="description"]`, `link[rel="canonical"]`, JSON-LD `name`/`headline`/`image`/`author`/`description`/`genre` on a work-shaped block (`Book`/`CreativeWork`/`Article`/etc. — JSON-LD blocks describing the site itself, e.g. `@type: Organization`, are read only for site-identity comparison, never as work metadata), and `meta[name="author"]`. Nothing else is ever inspected for this — no full-DOM scan, no chapter paragraphs, no comments, no account/user info, no cookies, no browsing history (`extension/src/tracking/universal/metadata.ts`, `detected-metadata.ts`).

**Extraction and bounding happens twice** — once in the extension (`extension/src/tracking/universal/detected-metadata.ts`) as a courtesy, and again, authoritatively, server-side (`src/lib/extension/detected-metadata.ts`) on every incoming request, since nothing from a request body is trusted just because the extension already validated it. Both apply the same bounds: URLs ≤ 2000 chars and http(s)-only, description ≤ 500 chars, ≤ 5 authors (≤ 100 chars each), ≤ 8 genres (≤ 40 chars each) — a page cannot cause an arbitrarily large database write no matter what it puts in its meta tags.

**Two deterministic filters, no LLM:**
- **Boilerplate descriptions** — a reading site's auto-generated SEO description reliably opens with an imperative addressed to the reader ("Read *Title* online for free…"); a real synopsis essentially never does. `isLikelyBoilerplateDescription` checks for exactly that (`/^read\b/i`) and discards a match rather than storing site boilerplate as a "description." Directly justified by two real strings observed on NovelPhoenix's own chapter and work pages.
- **Site-identity as author** — some sites put their own brand in `<meta name="author">` instead of omitting it (NovelPhoenix's is literally "Novel Phoenix"). Any author candidate that case-insensitively matches the site's own identity (`og:site_name`, or a JSON-LD `Organization.name`) is dropped, never stored as a credited author.

**Work URL vs. chapter URL:** `canonical` is per-chapter on every reader site tested and can't be used to derive a work URL. The work URL instead reuses universal detection's own URL-pattern stripping (`urlMatch.strippedPath` — the same logic that derives a source's stable key) to get the containing work's path. `tracking_sources` still separately records the chapter URL currently being read (`sourceUrl`); the LibraryItem's own `sourceUrl` prefers the stable work URL once one is derivable, since that's the page an "open source" action a year from now should land on, not whatever chapter happened to be open when the item was created.

**Merge policy — fill empty fields only, never overwrite:** enrichment (`src/lib/extension/enrichment.ts`, `enrichLibraryItemIfSparse`) patches a linked LibraryItem's cover/sourceUrl/description/authors (novel and manga)/genres (anime/series/manga/movie — **not** novel, which has no `genres` field in the type system at all; see "Reading format" above for the one novel-specific field this does still fill) one field at a time, and only when that field is currently empty. A field already holding *any* meaningful value — user-entered, catalog-imported, or filled by an earlier detection — is never touched again. This runs on **every** detection, not just the first: an item created sparse from "Add & Track" gets exactly the same enrichment pass on its next chapter update as an item that's been sitting sparse for weeks, with no unlink/delete/re-add required. No provenance tracking was added for this — "already has a value → never overwrite" needed none, and adding it would have been complexity with no behavior it enables today. `readingFormat` gets one additional, narrower rule: it's suggested as `"web_novel"` only while the item has neither a `readingFormat` already nor a `catalogSource` (so a future catalog provider that leaves its own format field blank is never overridden by a guess) — independent of whether any other enrichment field was actually found on a given detection.
Concurrency-wise, this deliberately does **not** use migration 0004's row-locking RPC the way progress updates must: two near-simultaneous detections for the same item race, at worst, to write the identical fill for the identical empty field, converging on the same result either way — not a duplicated side effect the way an unlocked progress write would be.

**One creation, not two:** when detected metadata is available at "Add & Track" time, it's included directly in the single `MediaItemInput` the item is created from (`src/lib/extension/detected-item.ts`) — never a minimal item followed by a second enrichment write. **Silent:** enrichment never creates an Activity event (no "cover changed," no "description added") — only a genuine progress/status change does, exactly as before Stage 21.

**Storage — no new migration.** `tracking_sources.last_detected_progress` (JSONB) gained an optional `metadata` key alongside its existing `kind`/`value` (`src/lib/extension/tracking-sources.ts`) instead of a new column; the enrichable LibraryItem fields (cover, description, authors, genres, work URL via `sourceUrl`) all already round-trip through the existing `library_items.metadata` JSONB (`src/lib/cloud/library-items.ts`) — both were already flexible enough, so no schema change was needed for Stage 21.

**What NovelPhoenix actually offers, verified live against a real chapter and work page:** `og:image` — a genuine, stable per-work cover (same URL on both page types) — extracted and used. `og:description`/`meta[name="description"]` — boilerplate on both page types, correctly filtered to nothing. `meta[name="author"]` — the site's own name, correctly filtered to nothing. Genre — present only as a `BreadcrumbList` link on the *work* page (e.g. "Xuanhuan"), not as a structured JSON-LD `genre` field anywhere, and not present at all on the chapter page the extension is actually reading; extracting it would require an extra background fetch of a second page and a breadcrumb-specific heuristic — deliberately **not implemented**, since it's exactly the kind of brittle site-specific reach-around Stage 21 was told to avoid. Generic JSON-LD `genre` extraction is still implemented for sites that do expose it directly (author/manga catalog sites commonly do); NovelPhoenix itself just yields nothing there. **Conclusion: detector `universal-reader`, metadata adapter `none`** — no NovelPhoenix-specific code exists anywhere in the metadata path.

### Optional Zero-Touch Auto-Add (Stage 22)

Stage 20/21's "Add or Link" still requires one click ("Add & Track") the first time Markly sees a work it doesn't already have. Stage 22 adds an **opt-in, off by default** preference that skips that click: when a detection confidently matches nothing already in the library, Markly creates the LibraryItem and links it automatically instead of waiting.

**Device-level, not account-level.** The toggle ("Automatically add new works") lives on each paired browser extension device, in Settings → Auto Tracking, under that device's row — not a global account setting. `extension_devices` already exists 1:1 per paired install and every request is already authenticated to a specific device (`authenticateDevice`, `src/lib/extension/devices.ts`), so this needed no new trust surface, and it directly matches the real use case (enabled on a phone browser, off on a work laptop, say). **Default is OFF for every device, including ones paired before this feature existed** — enabling it is always a deliberate, per-device action; nothing is turned on automatically. Turning it back off only affects *future* unknown works — it never unlinks a source, deletes an auto-added item, or stops tracking anything already linked.

**One source of truth.** The preference is read and written only through `/api/extension/devices/auto-add`, the same session-authenticated route Settings uses. The extension popup does not maintain a second copy of it — deliberately: the per-source `auto_track_enabled` toggle already established the precedent of being a web-Settings-only control, and adding a second UI surface for a rarely-changed boolean would only risk the "web says on, extension says off" split explicitly worth avoiding for a little convenience. The popup *does* change what it shows after a detection (see "Popup states" below), driven entirely by the same API response every other tracked page already uses.

**Priority — exact match still wins, ambiguous never auto-adds:**
```
source already linked?      → track (auto-add never re-considered)
attemptSmartAutoLink:
  unique exact title match  → link it (Stage 18, unchanged)
  ambiguous                 → needs_link — auto-add or not, never guesses
  no_match + auto-add ON    → create + link (this stage)
  no_match + auto-add OFF   → needs_link (Stage 20/21, unchanged)
```
Smart Auto-Link's own matching code (`src/lib/extension/auto-link.ts`) is untouched by this stage — auto-add only ever runs *after* it has already returned `no_match`, never in place of it, and its exact-match-only rule is not loosened anywhere.

**Atomicity — two locks, not one.** A device with auto-add on can receive many near-identical detections for a brand-new work in quick succession (retries, multiple tabs, a reload storm) — client-side button disabling doesn't apply here, since there's no button. `auto_add_and_link_source` (`supabase/migrations/0005_stage22_auto_add.sql`) handles this with two locks in one transaction:
1. `select ... for update` on the `tracking_sources` row — the same pattern as 0004's `apply_extension_progress` — serializes concurrent requests for the *same* source; a losing concurrent call sees `library_item_id` already set and links to nothing new.
2. `pg_advisory_xact_lock`, keyed on `(user, media type, normalized title)` — closes a narrower race the first lock alone can't: two *different*, both brand-new sources that happen to name the exact same work (e.g. two tabs, two sites, the same novel, at the same instant). Under the lock, `library_items` is re-checked once more for an exact match before anything is created; a match found here links instead of creating a second item.

Either lock resolving to "something already exists" is exactly as valid an outcome as "I created it" — the RPC returns `created`, `linked_existing`, or `already_linked` accordingly, and the API layer only ever reports a one-time `autoAdded: true` on the literal request that created the item (mirroring how `autoLinked: true` already worked for Stage 18's smart-auto-link).

**Server-side only.** The extension still sends nothing but a normalized detection (title/mediaType/progress/optional Stage 21 metadata) — never a LibraryItem id, never a userId, never the auto-add preference itself. Everything used to decide whether and what to create — the device's own preference, the authenticated `userId`, the match/ambiguity check — is derived server-side from the authenticated device token, the same as every other write this API makes.

**Created item fields.** Reuses Stage 20/21's `buildDetectedMediaInput` untouched (`src/lib/extension/detected-item.ts`) via a new `attemptAutoAdd` (`src/lib/extension/auto-add.ts`) that converts its result through the existing `createMediaItem`/`toLibraryItemRow` — an auto-added item has the exact same title/status/progress/readingFormat-suggestion/detected-metadata fields a manual "Add & Track" click would have produced, not a separate, thinner code path. No external catalog lookup (Open Library/AniList) is ever made as part of this — auto-add only uses what the current page already offered; catalog enrichment remains a manual, later action via the existing search flow.

**Activity.** One `item_added` event on creation — same shape as every other creation path (catalog search, manual entry, AniList import, or Stage 20's detected-work fallback all look identical in Activity; `item_added` has no provenance field for any of them, so this doesn't invent one just for auto-add). The initial progress baked into the item at creation is not a "transition" (no prior value to diff against), so it produces no `progress_updated` event — same rule Stage 20 already established for manual Add & Track. Enrichment (Stage 21) remains silent either way.

**Known limitation, stated plainly:** the advisory lock closes the cross-source race *for auto-add against itself*. It does not (and cannot, without a much broader change) close a race against a plain manual "Add Item" happening at the exact same instant for the exact same title — that path was never lock-protected even before this stage. This is an extremely narrow, pre-existing gap in the wider architecture, not something Stage 22 introduces or claims to have closed.

### Real-World Manga Tracking (Stage 23)

The second real target, [MangaDex](https://mangadex.org), proves the whole Stage 18–22 pipeline (permissions, detection, Smart Auto-Link, Auto-Add, enrichment) generalizes past text-based novels — with two real gaps closed along the way, both **generic infrastructure, not MangaDex-specific patches.**

**Media-type classification.** Universal detection could always tell "chapter" from "episode," but not manga from novel — nothing in generic page structure safely distinguishes them (and "many `<img>` tags" is exactly the kind of guess Stage 23 was told not to make). `extension/src/tracking/universal/site-capability.ts` adds a tiny, explicit hostname → `manga` lookup, checked only after a detection is otherwise confident; every unlisted host still defaults to `novel`, unchanged from Stage 19. This is deliberately *not* a full adapter — it answers one question ("manga or novel?") for pages universal detection can otherwise read confidently on its own.

**A real MangaDex adapter was still required** (`extension/src/adapters/mangadex.ts`), for an unrelated reason verified by directly inspecting a live chapter page: MangaDex's reader has **zero `h1`/`h2` elements anywhere** (its chapter title renders into a plain, unlabeled `<div>`) and its URL is `/chapter/<uuid>` — no numeric chapter segment at all. That leaves only 2 of universal detection's 4 primary signals able to fire (`document.title`, `og:title`) for 35 combined weight, under the 55-point `CONFIDENCE_THRESHOLD` — universal detection would never confidently detect a single MangaDex page, independent of the media-type question entirely. **Preferred outcome achieved for the classification question; not for detection itself** — see the honest accounting above rather than a blanket "no adapter needed."

The adapter's own signal design went through one real-world correction after initial deployment. It originally required `document.title` and `og:title` to independently agree on the chapter number (a reasonable-looking substitute for universal's multi-signal scoring). Live, timed testing against a real "Next Chapter" click found that MangaDex's `<meta property="og:title">` tag **never updates on client-side navigation** — it stays fixed at whatever chapter the page was first server-rendered for, confirmed still stale a full 1.5 seconds and two chapters later. Requiring agreement with a permanently-stale signal meant detection silently failed on every SPA navigation after the first chapter of a session — exactly the "Next Chapter → Markly updates automatically" case this stage exists for. `og:title` is no longer consulted at all: `document.title` (empirically reliable within ~200ms of a real navigation) is the sole chapter-number source, and work identity/title instead comes from the page's own `/title/<uuid>/<slug>` anchor(s) — a completely independent signal, validated with a strict UUID-format check, `/title/random` explicitly rejected, and detection refusing to guess if the page's anchors ever point to more than one distinct manga UUID. The adapter otherwise stays narrow, reusing `parseProgressText` and `buildDetectedMetadata` verbatim from the universal engine.

**Stable source identity** is the manga UUID, never the current chapter's own release UUID — `mangadex.org::<manga-uuid>`, identical across every chapter of that manga and across different scanlation groups' releases of the same chapter number, verified live across two real chapters of the same series.

**Generic SPA navigation support.** MangaDex is a client-side-routed Vue app — verified directly (a `beforeunload` probe never fired across a real "Next Chapter" click; the URL changed via `history.pushState` with the page's own JS context never destroyed) — so the content script's previous one-shot-per-page-load model would only ever see the *first* chapter a tab was opened on. `extension/src/content/content-script.ts` now patches `history.pushState`/`replaceState` and listens for `popstate` — the two/three mechanisms virtually every client-side router uses under the hood — debounced 600ms so one route transition triggers one re-detection. This is not a MutationObserver and never observes page content, continuously or otherwise; it only reacts to the URL itself changing, and benefits *any* SPA reader site, not just MangaDex. Verified live: a real "Next Chapter" click correctly fired exactly one re-detection with the new chapter's title.

**Decimals.** `MangaItem.currentChapter` already documented decimal support (split-release chapters like `12.5`); the extraction regexes (`extension/src/tracking/universal/url.ts`, `progress.ts`) just hadn't implemented it yet — both now accept an optional `.digits` suffix, a strict superset that doesn't change how a plain integer chapter parses (verified: NovelPhoenix's `chapter-52` still parses as `52`, not `5` or `2`). No decimal chapter was directly observed on the two manga inspected live; the capability is there for when one is.

**Safe metadata — a real, non-obvious exception found.** MangaDex's **work** page (`/title/<uuid>/...`) has a genuine, stable per-manga cover (`og.mangadex.org/og-image/manga/<uuid>`) and rich structured Author/Artist/Genre fields — but a **chapter** page's own `og:image` is generated *per chapter* (`og.mangadex.org/og-image/chapter/<uuid>`), and chapter pages have no author/genre metadata at all. Since real detections only ever run on the chapter page (never an extra fetch of the work page), blindly reusing Stage 21's cover extraction would have silently stored the wrong, chapter-specific thumbnail as if it were the series cover — and Stage 21's fill-once merge policy would never self-correct it afterward. `buildDetectedMetadata` gained an optional `trustPageCover` flag (default `true`, safe for every other site tested so far); the MangaDex adapter passes `false`. Net result for a real MangaDex chapter page: no cover, no author, no genres, no description (boilerplate-filtered, same as NovelPhoenix) — only a stable `workUrl`. Catalog search (AniList, already wired for manga) remains the way to get real cover/author/genre metadata for a MangaDex-detected item, unchanged from before this stage.

**Cross-media isolation.** Smart Auto-Link and the Auto-Add advisory lock were already media-type-scoped before Stage 23 (verified, not just assumed): a Manga and a Novel sharing the exact same title were never candidates for each other, and concurrent auto-add of both never collapses into one item — `p_media_type` was already part of both the lock key and the exact-match recheck's `WHERE` clause in the already-deployed `auto_add_and_link_source`. **No migration was needed for Stage 23.**

## Project Structure

```
src/
  app/            Next.js App Router routes (/, /library, /library/[id], /login, /signup,
                  /settings/connections, /settings/tracking, /dev/reader-test,
                  /dev/reader-test-generic/[chapter], layout, global styles, icon)
  app/api/integrations/anilist/  Server-only AniList OAuth + import/sync route handlers
  app/api/extension/             Server-only device pairing + auto-tracking API (extension-facing)
  app/api/tracking-sources/      Session-authenticated tracking-source list/link/unlink (web-app-facing)
  components/     UI components (item cards, dialogs, filters, forms, theme toggle, auth, connections,
                  auto-tracking settings, etc.)
  data/           Starter/mock library data used on first visit
  hooks/          Local/cloud-aware data hooks (useLibraryItems, useCollections, useActivity, useLocalImport)
  lib/            Pure helper functions (filtering, sorting, storage, validation, activity formatting)
  lib/metadata/   Per-type catalog search providers + registry (see "Metadata Search" above) — novel's
                  provider merges Open Library and AniList; every other type is a single source.
                  relevance.ts ranks/filters a provider's results for display (see "Add or Link" above)
                  — display-only, never touches Smart Auto-Link
  lib/cloud/      Supabase data-access + row/LibraryItem mapping + local→cloud migration
  lib/supabase/   Supabase browser/server client factories, env config, and the server-only admin
                  (Secret API Key) client used only by the extension-facing API
  lib/integrations/         Provider-neutral connection storage + token encryption
  lib/integrations/anilist/ AniList OAuth, GraphQL client, mapping, and sync engine
  lib/extension/  Device pairing, device-token/pairing-code hashing, the pairing-endpoint rate
                  limiter, tracking-source persistence (incl. the atomic first-link claim), smart
                  auto-linking (auto-link.ts), detected-work → LibraryItem mapping for the
                  no-catalog-match fallback (detected-item.ts), and the thin RPC wrapper
                  (progress.ts) behind /api/extension/progress — the concurrency-safe
                  compare-and-write logic itself lives in the database, see
                  supabase/migrations/0004_*
  types/          Shared TypeScript types
scripts/
  verify-atomic-progress.mjs  Standalone concurrency check for the apply_extension_progress logic
                  (see "Progress safety" above) — run with `node scripts/verify-atomic-progress.mjs`
  verify-smart-auto-link.mjs  Standalone check for the auto-linking match rules and the concurrent
                  first-link claim (see "Source mapping" above) — run with `node scripts/verify-smart-auto-link.mjs`
  verify-title-extraction.mjs  Standalone check for real-world page-label title cleaning (see
                  "Real-site validation" above) — run with `node scripts/verify-title-extraction.mjs`
  verify-detected-work.mjs  Standalone check for the detected-work fallback's format/progress/status
                  derivation and duplicate-click guard (see "Add or Link" above) — run with
                  `node scripts/verify-detected-work.mjs`
  verify-title-relevance.mjs  Standalone check for catalog-result relevance ranking, including the
                  exact "Lord of the Mysteries" / Open Library fuzzy-match bug report (see "Add or
                  Link" above) — run with `node scripts/verify-title-relevance.mjs`
supabase/
  migrations/     SQL schema + Row Level Security policies for the optional Supabase backend
extension/
  manifest.json   Manifest V3 — permissions, service worker, popup, options page,
                  optional_host_permissions (see "Runtime site permissions" above)
  src/adapters/   Site adapter interface + registry (overrides/fallbacks for specific sites)
  src/tracking/universal/  Universal detection engine (default path — see "Architecture" above):
                  metadata.ts, url.ts, headings.ts, progress.ts, navigation.ts signal extraction,
                  confidence.ts scoring, detect.ts orchestration (incl. real-world title cleaning),
                  diagnostics.ts (dev-only console.debug explainability, never sent anywhere)
  src/background/ Service worker — the only context that holds the device token or calls the Markly
                  API; injects the content script based on scope (dev origin + user-granted origins)
  src/content/    Content script — picks adapter vs. universal detection, always reports its result
                  (even null); never sees the device token
  src/popup/      Plain HTML/TS/CSS popup, no framework — pairing, per-site enable prompt, page status
  src/options/    Plain HTML/TS/CSS options page — view/revoke granted site permissions
  src/lib/        Extension-side storage/API/config/site-permissions helpers
  scripts/build.mjs  esbuild bundler (see "Auto Tracking" above for build commands)
```

## Future Improvements

- OAuth sign-in for Markly itself (Google/GitHub/etc. — distinct from the AniList connected-account feature above)
- Additional connected providers (Trakt, Steam) on the same connected-accounts architecture
- Background/automatic AniList sync (currently manual "Sync Now" only)
- Markly → AniList outbound writes (currently inbound-only)
- A real Stage 19 site adapter (NovelPhoenix or similar) using `optional_host_permissions`
- Firefox/Edge extension support (Chromium-based Manifest V3 only for now)
- Bookmark/library import/export
- Offline conflict resolution for account mode (currently last-write-wins with no merge)
