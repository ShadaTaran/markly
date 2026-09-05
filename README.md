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

### Episode/Video Tracking (Stage 24)

Reading and watching are different acts: opening a chapter's page *is* reading progress, but opening an episode's page is not proof of having watched it. Stage 24 introduces that distinction cleanly, without touching novel/manga's existing behavior (chapter-kind detections still commit immediately, exactly as since Stage 18) and without a second, parallel tracking system — it's one new optional flag threaded through the existing pipeline.

**Discovery vs. commit.** An episode-kind (`progress.kind === "episode"`) detection now sends an immediate **discovery ping** (`commitProgress: false` in the request body) the moment the episode is confidently identified — this still runs Smart Auto-Link and, if enabled, Auto-Add, so "Add or Link" (or an auto-created item) is available right away, without waiting for anything to be watched. `/api/extension/progress` (`src/app/api/extension/progress/route.ts`) branches on this single flag: identity/linking/auto-add all run unchanged, but `applyDetectionToItem` — the one function that actually writes `currentEpisode` and inserts Activity — is skipped entirely, returning a new `"detected"` status instead. The eventual **completion event** is just an ordinary `commitProgress: true` (or omitted) request through the exact same route, reusing 100% of the existing monotonic-progress path unchanged. No new migration, no new RPC — `body.commitProgress !== false` is the only new server-side concept, and any client that never sends it (every reading-media detection, past and future) behaves exactly as before.

**Never baking in an unwatched episode.** If Auto-Add fires from a discovery ping, the created item gets `status: "in_progress"` (Watching) but *not* `currentEpisode: 7` — `buildDetectedMediaInput`'s anime/series cases (`src/lib/extension/detected-item.ts`) check a `confirmed` flag on the cached detection (`tracking_sources.last_detected_progress`, widened the same JSONB-value way Stage 21/22 already did — no new column) and only bake in the episode number when it's `true` (the default for every reading-media detection) or absent (full backward compatibility). The first real progress commit — the completion event — sets `currentEpisode` for the first time, through the unchanged, already-monotonic `apply_extension_progress` RPC.

**Completion policy** (`extension/src/tracking/video/completion.ts`, fully generic — no site ever implements its own version of this):
- `currentTime / duration >= 0.85`, **or** a genuine `ended` event.
- **And**, independently, at least `50%` of the video's duration in real, accumulated *forward playback time* — tracked via `timeupdate` deltas while actually playing (not seeking), explicitly separate from the player's current *position*. Seeking straight to 99% and letting one frame play through to `ended` fires the `ended` branch above but fails this one: accumulated playback stays near zero, so it's correctly rejected. Rewinding to re-watch a scene only ever adds to accumulated time (never subtracts), so a genuine rewatch-and-continue never gets penalized.
- Fires `onComplete()` at most once per observer instance; further `timeupdate`/`ended` events after that are no-ops.

**Primary video selection** (same file): never assumes the first `<video>` in document order is the episode player. Filters to visible, adequately-sized (≥160×120px) candidates; with exactly one, uses it; with several, requires the largest to be at least 2× the area of the runner-up (a main player next to small preview thumbnails) or refuses to guess. If no confident primary video can be identified — including the common real case of a player rendered inside a cross-origin iframe, which this deliberately never attempts to reach into — the episode is still detected and reported, just with no completion tracking; the popup says so explicitly rather than silently pretending to watch.

**Bugfix — async player mounting.** A real manual test on the dev harness itself found completion tracking permanently unavailable despite a real, correctly-sized, visibly-playing `<video>` being right there. Root cause, proven with direct instrumentation rather than assumed: `selectPrimaryVideo` was only ever called once, at the exact moment an episode was first detected — and a page's player frequently isn't in the DOM yet at that instant (confirmed live: `document.readyState` was already `"complete"`, several real seconds before the harness's own `<video>` element existed at all). The original code gave up permanently on a `null` result; nothing ever retried. Player discovery (`discoverPrimaryVideo`) is now bounded-but-retried: tried once immediately (the common case), and only if that fails, watched for via a `MutationObserver` capped at a 15-second total budget — event-driven, never a polling interval, and disconnected the instant a video is found, the budget elapses, or the episode changes. A related, second issue found along the way and fixed defensively (not the proven cause of this specific report, but a real risk on a real page): the DOM-mutation coalescing is a *throttle*, not a debounce — the first mutation in a burst schedules exactly one re-check; further mutations before it runs are ignored rather than pushing it back out again, so a page with sustained DOM churn (a chat widget, ad refreshes) faster than the coalescing window can't starve the check indefinitely the way a plain debounce would. The popup distinguishes a normal, brief settling window ("Finding video player…") from a genuinely exhausted search ("Automatic completion tracking unavailable"), via a new locally-only `PLAYER_STATUS_UPDATE` message. Verified live end-to-end (with the async-mount timing reproduced exactly as reported): discovery correctly finds the video once it mounts, several seconds after the initial detection.

**What never leaves the browser.** The observer tracks two ephemeral local numbers (accumulated playback seconds, current ratio) for exactly as long as it's alive — no `currentTime` series, seek history, pause history, volume, captions, or video source URL is ever sent anywhere, and none of it is persisted to `chrome.storage`. The only thing that ever reaches Markly is the single completion event once eligible (one POST, same shape as any other progress update) — never a percentage, never a stream of updates. The live "Watching · 42%" the popup can show is relayed **locally only**, content-script → service-worker → popup-on-demand, via a new `WATCH_PROGRESS_UPDATE` message that never touches the network (throttled to roughly once/second, itself just a courtesy against needless message spam, not a privacy boundary — the boundary is that this message type has no server-side handler at all).

**Real-world investigation: Crunchyroll.** Verified live, unauthenticated (no login/subscription bypass attempted): series/episode pages exist at stable, discoverable URLs (`/series/<id>/<slug>`, `/watch/<id>/<slug>`) with real episode metadata (title, description, next-episode data) visible without an account. Two real, concrete limitations found, both honestly load-bearing on the design above rather than papered over: (1) `document.title` is initially generic and, even after hydration, never includes a numeric episode indicator in a form the existing conservative parser recognizes (Crunchyroll's own heading shorthand is bare `"E1"`, not `"Episode 1"`/`"Ep. 1"` — extending the pattern to match bare `E<N>` universally was deliberately **not** done, given the false-positive risk of that shape appearing in unrelated headings elsewhere, e.g. `"S2E1"`); (2) most importantly, **no `<video>` element exists in the top-level document** in the unauthenticated state — the player loads into a blank, presumably cross-origin iframe not populated without logging in. Given (2) alone makes completion tracking unavailable on this specific site regardless of (1), **no Crunchyroll-specific adapter was written** — building one would only ever produce "detected, completion unavailable," and per the project's standing "don't build site-specific code speculatively" rule, that isn't worth a dedicated adapter. This is exactly the real-world case the "player inaccessible" design (above) exists for, and Crunchyroll is the concrete, honestly-documented proof it was necessary, not hypothetical.

**Dev harness** — `/dev/video-test/episode-N`: ordinary universal-detectable markup (real `<h1>`, matching document/og title, an `/episode-N` URL) plus a real, ~12-second HTML5 `<video>` generated entirely client-side (`<canvas>` + `MediaRecorder`, manual-frame-capture mode driven by `setInterval` rather than `requestAnimationFrame` — the latter throttles to near-zero in a backgrounded/automated tab, which was directly observed producing an almost-frameless, effectively unplayable recording before this fix) — no bundled or fetched video asset, so nothing here is or could be copyrighted footage. Test buttons cover a genuine play-through and the seek-cheat scenario (seek to 99%, let it "end" with almost no real playback) side by side. Verified live: a genuine play-through correctly completes (~11.5s of ~11.6s duration accumulated); the seek-cheat correctly does not (~0.1s accumulated, `ended: true`, `completed: false`).

**Smart Auto-Link / cross-media isolation:** unchanged, untouched file (`src/lib/extension/auto-link.ts`) — an Anime source is still never a candidate against a same-titled Novel or Series item.

### Season-Aware Episode Tracking (Stage 25)

`currentEpisode: number` correctly represents Episode 1 → 2 → 3, but not a season transition: Season 1 Episode 12 → Season 2 Episode 1 is a numeric *decrease* (12 → 1) that a plain "must advance" compare-and-set would reject as backwards progress. Stage 25 adds a second, explicit numbering mode rather than trying to make one number do both jobs.

**Numbering mode, additive and opt-in.** `AnimeItem`/`SeriesItem` gain two new optional fields: `episodeNumbering?: "absolute" | "seasonal"` and `currentSeason?: number`. **Absent means absolute** — every item created before Stage 25, and every AniList-synced item (AniList's integration was re-verified to only ever write plain `currentEpisode`, never `currentSeason`/`episodeNumbering` — see `src/lib/integrations/anilist/sync.ts`), is interpreted exactly as it always has been. Nothing is ever silently reinterpreted: the field is only ever set explicitly, by a form edit or by a season-aware detection.

**Wire shape.** The extension's `TrackingProgress` gains an optional `season?: number`, read only when `kind === "season_episode"` — every other kind (including plain `"episode"`) never sets it, so every pre-Stage-25 consumer that only ever read `{kind, value}` (popup formatting, the service-worker's dedup cache, `StoredDetectionProgress`) keeps compiling and working unchanged; only code that actually needs to distinguish the two kinds does.

**Comparison is lexicographic, in the database.** A season+episode pair can't be compared by reading one field, deciding in JavaScript, then writing — that reopens the exact read-compare-write race Stage 18's `apply_extension_progress` closed for the numeric case. `apply_extension_season_episode_progress` (`supabase/migrations/0007_stage25_season_progress.sql`) locks the row, then compares `(season, episode)` as a tuple: a **higher season always wins, regardless of episode** (S2E1 beats S1E20); within the same season, only a **higher episode** wins; a **lower season never wins**, no matter how high its episode number. A `numbering_mismatch` status protects every item that isn't already explicitly seasonal — one with a real `currentEpisode` already recorded and no seasonal marker (every legacy item, every AniList item) refuses a seasonal write outright rather than being silently converted; only an already-seasonal item, or one with no progress recorded at all yet, accepts one.

**Discovery/commit preserved.** A season-aware detection still sends an unconfirmed discovery ping first (Stage 24's split, unchanged) — Auto-Add may create the item and mark it `episodeNumbering: "seasonal"` right away, but `currentSeason`/`currentEpisode` stay unset until a real completion commits them (`buildDetectedMediaInput`, `src/lib/extension/detected-item.ts`).

**UI.** `MediaItemForm` gets an "Episode numbering" select (plain copy — "Absolute episodes" / "Season + episode", no DB jargon) and a conditional "Season" field; switching numbering mode is always an explicit, visible save, never an automatic conversion (17 is never silently turned into "S1E17"). Card/detail progress display (`getProgressInfo`, `src/lib/tracking.ts`) shows "Season 2, Episode 3" for a seasonal item with no percent bar (a per-season length is never calculated or guessed — `totalEpisodes` stays a whole-series total). The quick "+1" control only ever advances the in-season episode number — it never infers a season rollover from arithmetic, and (having no per-season length to compare against) is never shown as "at max" for a seasonal item. Activity history reads "S1E12 → S2E1", never a bare "12 → 1".

**Bugfix — activity storage's progress-kind whitelist.** Proven live on the dev harness: creating a seasonal item and clicking "+1" wrote a correct `progress_updated` event to `localStorage` — but the *next* page load silently lost it. Root cause: `activity-storage.ts`'s `loadActivity()` filters out any event whose `progressKind` isn't in a hardcoded list (`PROGRESS_KINDS`), which didn't yet include `"season_episode"` — the filtered (event-missing) list was then immediately written back by the ordinary hydration-triggered persistence effect, permanently erasing the real event. Fixed by adding `"season_episode"` to the list (and validating its optional `previousSeason`/`newSeason` fields the same way `previousValue`/`newValue` already were); the same gap existed in the cloud round-trip (`src/lib/cloud/activity.ts` dropped `previousSeason`/`newSeason` when reading/writing Supabase's `activity_events.data` JSONB) and was fixed alongside it. Verified live end-to-end after the fix: the event now survives a real page reload, and the Dashboard's Recent Activity correctly renders "S2E5 → S2E6".

**Dev harness** — `/dev/video-test/show/season-N/episode-M`, reusing Stage 24's generated-video component. Read by a dedicated, narrowly-scoped adapter (`extension/src/adapters/markly-season-test.ts`, matching only Markly's own dev origin) rather than an extension to universal detection — Stage 25 is the progress *model*, not provider expansion, and no real-world evidence backs a generic season URL/heading shape the way Stage 23's chapter/episode patterns had.

**Not implemented (deliberately out of scope for this stage):** any real streaming-site adapter, automatic season-length calculation, cross-season AniList merging, specials/OVA reconciliation, and season editing in the detail page's lightweight "Your Tracking" quick-edit card (only the full Edit Details form exposes the Season field — see the module comment in `src/lib/extension/detected-item.ts`'s `buildDetectedTrackingValues` for why `CatalogTrackingForm`'s compact add-from-catalog flow was left untouched too).

### Cross-Source Work Identity (Stage 26)

The same work can be read/watched from more than one site — NovelPhoenix says Chapter 58, a different reader says Chapter 59. Both should point at one Markly item with one unified progress, without a fuzzy "these titles are probably the same work" merge step anywhere in the pipeline.

**`tracking_sources` already supported this.** Phase 0 investigation found the only uniqueness constraint on the table is `(user_id, adapter_id, source_key)` — on *source* identity, never on `library_item_id`. Nothing has ever stopped two source rows from sharing one `library_item_id`. The existing atomic progress RPCs (`apply_extension_progress`, `apply_extension_season_episode_progress`) already lock and compare purely by `p_item_id`, oblivious to which source triggered the call — so two sources racing to update the same item already serialize correctly and the monotonic rule already picks the right winner. **No new "canonical work" table, and no RPC changes, were needed** — this stage is almost entirely about *exposing* an architecture that was already correct, not building a new one.

**The one real gap: Unlink was practically useless.** A user explicitly unlinking a source only ever cleared `library_item_id` — the very next detection would run Smart Auto-Link, find the same exact-title match, and silently relink it right back. `tracking_sources.auto_link_suppressed_at` (new, `supabase/migrations/0008_stage26_source_management.sql`) is the minimal fix: set only by an explicit user Unlink (never by `clearBrokenLink`, which runs when a *linked item was deleted* — that case must stay free to auto-relink or Auto-Add normally), it makes `/api/extension/progress` skip Smart Auto-Link *and* Auto-Add entirely for that source until the user explicitly links it again (which clears the flag). `last_seen_at`/`last_detected_progress` keep updating normally throughout — only the automatic *linking decision* is suppressed.

**Disabled-source enforcement already existed** (Stage 22) — `/api/extension/progress` already returns `tracking_disabled` before any linking or progress-commit logic runs whenever a linked source's `auto_track_enabled` is false. Stage 26 found no gap here; it only added the missing UI to actually flip the toggle (`POST /api/tracking-sources/toggle-auto-track` — `setAutoTrackEnabled` existed server-side since Stage 18 with no route ever calling it).

**Friendly names, never raw ids.** `src/lib/extension/source-display.ts` maps a source to a human label — a known adapter's own `displayName` first (`MangaDex`), then the source's own hostname (`novelphoenix.com`, or the friendlier `NovelPhoenix` where that mapping is known), and only a raw `adapterId` (`universal-reader`, `markly-season-test`) as an absolute last resort when neither is available. The same module formats `last_detected_progress` for display — an unconfirmed video discovery (`confirmed: false`) reads as `"Detected: Season 2, Episode 3 (not completed)"`, never as if it were committed Library progress — and validates "Open Source" links (`getSafeOpenSourceUrl`, reusing `lib/website.ts`'s existing `isValidUrl` rather than reimplementing it): only `http`/`https`, never `javascript:`/`data:`/`file:`/malformed.

**Item detail page** gets a new Tracking Sources section (`ItemTrackingSourcesSection.tsx`) answering "where is Markly tracking this from?" without opening Settings — fetches only this item's sources (`GET /api/tracking-sources?libraryItemId=…`, a new targeted query, `listSourcesForItem`) rather than every source the user has, and renders nothing at all when there are none (no empty-card clutter) or when signed out (tracking sources are an entirely cloud/extension concept with no local-mode equivalent).

**Settings > Auto Tracking** now groups linked sources under the LibraryItem they share (`groupLinkedSources`) instead of one flat list, so "2 sources" under one title is visible at a glance; unlinked sources keep the exact same "needs attention" flow as before, untouched, in their own section.

**Bugfix (self-caught, cross-stage).** Both `GET /api/tracking-sources` and `settings/tracking/page.tsx` mapped `last_detected_progress` without its `season` field — a Stage 25 gap this stage's own source-display work surfaced: a seasonal source's progress silently lost its season on the Settings page even though the underlying column always had it. Fixed at both call sites.

**Not implemented (deliberately out of scope for this stage):** a "Forget/delete source" action (Unlink already covers "stop associating this source," and nothing in the current product needs the source row itself gone — documented here rather than added speculatively); Activity attribution by source (`"via NovelPhoenix"`) — would need a new parameter threaded through the already-live `apply_extension_progress`/`apply_extension_season_episode_progress` RPCs for a display-only enhancement the spec explicitly allowed skipping; identifier-based (non-title) matching improvements — no adapter or the universal engine currently exposes an authoritative work identifier at all (MangaDex's UUID is folded into `sourceKey`, never surfaced separately), so there is nothing yet for this to attach to.

### Safe Duplicate Detection & Manual Merge (Stage 27)

Two LibraryItems can end up representing the same work — one added manually, one Auto-Added, one imported from AniList — and they should never be silently combined. This stage adds a conservative *suggestion* (never automatic) and an explicit, reviewed, atomic *merge* action.

**Detection is deterministic, never fuzzy.** `lib/duplicate-detection.ts` groups items by exactly two signals: an identical `catalogSource.provider` + `externalId` (the strong signal — Frieren and "Frieren: Beyond Journey's End" sharing one AniList id are suggested even though the titles differ), or an identical *exact normalized* title + media type, reusing `normalizeTitleForMatching` from the very same shared module Smart Auto-Link uses (`lib/title-normalization.ts` — moved out of `lib/extension/auto-link.ts` this stage specifically so this client-side module could reuse it without pulling in that file's `server-only` marker). No Levenshtein, no embeddings, no partial-title matching, anywhere — "Lord of the Mysteries" and "Lord of Mysteries" are deliberately different keys, "Overlord" and "Overlord II" never group. A title match between two items whose catalog identities actively *conflict* (both set, and different) is withheld entirely — same title, but a strong signal they may be different real-world works. Three-or-more copies of the same work group into one duplicate group via a small union-find, never a pairwise A↔B/A↔C/B↔C explosion. Runs entirely client-side over items the view already has — no new server queries.

**Merge is explicit, previewed, and reviewed per pair.** A subtle "Potential duplicates · N" card appears on the Library page (never a banner); "Review" opens a comparison of the two oldest items in a group, the user picks which one survives (a completeness heuristic pre-selects a recommendation, but never chooses silently), and a live preview shows exactly what will be preserved before the "Merge Items" button does anything. Groups larger than two are handled by merging one pair at a time and reviewing again — no N-way merge workflow was built for what the spec's own test matrix never exercises beyond pairs.

**Field-merge policy** (`lib/library-merge.ts`'s `computeMergedLibraryItem`, pure and synchronous — used for both the live preview and local mode's actual write): survivor wins for scalar fields when non-empty (title, category, cover, ...), filled from the duplicate only when the survivor's own value is empty; favorite is `OR`; status and rating never average or auto-select "the higher one"; tags/genres/authors are unioned and case-insensitively deduped; progress always preserves the *furthest* position (absolute episode/chapter/playtime: higher number wins; seasonal: Stage 25's own lexicographic season-then-episode comparison, never raw episode number). Two things are never guessed: a numbering-mode conflict (one item absolute, one seasonal) and a progress-unit conflict (novel progress tracked in different units) both **block the merge entirely** with a plain-language explanation, rather than fabricating a conversion — same for two items with genuinely conflicting catalog identities.

**Cloud merge is one atomic transaction, not a sequence of API calls** (`supabase/migrations/0009_stage27_merge_library_items.sql`, `merge_library_items`). Two things Phase 0 investigation found that shaped it:
- `collection_items` and `activity_events` have **no UPDATE row-level-security policy** (only SELECT/INSERT/DELETE) — a plain `UPDATE ... SET item_id = ...` is silently rejected under `security invoker`. Both are moved via INSERT + DELETE instead (an `ON CONFLICT DO NOTHING` handles a collection both items already share).
- A TrackingSource can commit real progress to the about-to-be-deleted duplicate at any moment, including while the merge transaction is running. The RPC never trusts the browser's precomputed "merged progress" value — after locking both rows (in deterministic uuid order, so a concurrent "merge A into B" and "merge B into A" can never deadlock, only serialize), it independently recomputes every progress-bearing field from whatever the two rows *actually* contain at that instant, using the exact same furthest-wins/lexicographic-seasonal/conflict-blocking rules as the client preview. The browser's computation is trusted only for fields nothing else in the system writes concurrently (title, tags, genres, cover, catalogSource). Session-authenticated via `auth.uid()` (not a passed user id) — a pure web-app action, matching `linkSource`/`unlinkSource`'s existing pattern rather than the extension RPCs' service-role pattern. The duplicate is deleted last, only after every relationship above has already moved; any failure rolls back the whole transaction untouched.

**Local mode is a genuine parity implementation, not a stub** — collections have no join table locally (`Collection.itemIds` is a plain array), so reassignment is a direct array transform; there is no local tracking-sources concept at all (Stage 22 pairing is cloud-only), so that relationship simply doesn't apply. **Bugfix, caught live (not assumed):** the very first local-mode merge test showed a collection membership silently vanishing instead of moving to the survivor. Root cause: `useCollections`' self-healing effect strips any collection itemId no longer present in the library, reacting whenever `items` changes — reassigning collections *after* removing the duplicate from the library gave that effect a window to see the duplicate's now-dangling id and strip it before the reassignment ever ran. Fixed by reordering: collections/Activity are reassigned *before* the duplicate is removed from `items`, so both land in the same synchronous state-update batch and the cleanup effect never observes an in-between state with nothing to strip. Verified live both ways (the bug reproduced, then the fix confirmed) — see `scripts/verify-duplicate-merge.mjs`'s explicit ordering regression tests.

**Not implemented (deliberately out of scope for this stage):** automatic/fuzzy merging of any kind; a resolution UI for numbering-mode/progress-unit conflicts (blocked outright instead); a "Merged duplicate item" Activity event (would need new Activity schema — preserving the *existing* history intact was judged more valuable than adding a new event type for this); exact tracking-source/collection counts in the review dialog (shown generically as "preserved" rather than adding a per-item fetch just for a number — collections *are* shown with an exact count, since that data is already loaded client-side with no extra query); bulk/N-way merge UI.

### Destructive Action Recovery & Undo (Stage 28)

Delete and Merge are the only two genuinely destructive LibraryItem actions in Markly. This stage gives both a short-lived (15-minute), transactional Undo — deliberately narrow: it is not a Trash, not version history, and not general event sourcing.

**Why Undo has to re-validate, not just replay.** The motivating scenario: merge item A (Chapter 50) and B (Chapter 60) into a survivor at Chapter 60, let a browser tab genuinely advance that survivor to Chapter 61 via ordinary tracking, then click Undo Merge. A naive "replay the reverse of what happened" Undo would silently throw the real Chapter 61 away. Every restore path here instead re-validates the *current* state against what was recorded at the time of the original action, and refuses — with plain-language copy, never raw statuses — whenever anything has genuinely changed since. The single mechanism that makes this checkable at all: a full-row snapshot taken right after the original action, compared for exact equality against the current row before Undo is allowed to touch anything. A timestamp alone was deliberately not used for this (Section 16's own caution) — equality is unambiguous where "did `updated_at` get bumped by every code path" is not.

**`library_recovery_actions`** (new, `supabase/migrations/0010_stage28_library_recovery.sql`) stores exactly two action types — `delete_item` and `merge_items` — as a JSONB payload with a 15-minute `expires_at`. No `consumed_at` flag: a successful Undo deletes its own row, so "does this row still exist" *is* the double-undo guard — a second concurrent Undo request simply finds nothing. No background cleanup job either; each RPC opportunistically deletes the calling user's own expired rows before doing anything else, piggybacked on real traffic rather than a cron/Edge Function. The payload never contains credentials or tokens — `tracking_sources` itself has no such columns to begin with (verified against 0003: `adapter_id`, `source_key`, `source_title`, `source_url`, `media_type`, `auto_track_enabled`, `last_detected_progress`, `last_seen_at`, `auto_link_suppressed_at`, all already user-visible).

**Both RPCs run `security invoker`, not `security definer`** — the same choice `linkSource`/`unlinkSource`/`merge_library_items` already made in earlier stages, and for the same reason: every table these functions touch already has the RLS policies needed (including the `collection_items`/`activity_events` INSERT+DELETE-not-UPDATE pattern Stage 27 established), so there's no operation here that genuinely requires elevated privilege. `auth.uid()` gates every check; nothing ever trusts a client-supplied user id.

**`delete_library_item_with_recovery`** locks the item row, captures it (`to_jsonb`), its collection memberships, its full Activity rows, and the ids of any currently-linked TrackingSources — all in the same transaction as the delete itself, so a crash between "delete" and "remember what was deleted" can't happen. It never manually touches `collection_items`/`activity_events`/`tracking_sources` beyond that snapshot — the existing `ON DELETE CASCADE`/`ON DELETE SET NULL` foreign-key behavior (0001/0003) does the actual cleanup, unchanged.

**`undo_library_recovery`** handles both action types. Delete-undo: the original id must still be free, every recorded collection must still exist, and — the TrackingSource case Section 18 specifically calls out — a source is only ever relinked back if it's *currently unlinked* (`library_item_id IS NULL`); one that's since been claimed by a different item is left alone, never stolen back. Merge-undo: the central check is `to_jsonb(current_survivor) IS DISTINCT FROM` the row recorded immediately after the original merge — any real difference (new progress, a rating change, a second unrelated merge) blocks Undo outright, which is also what makes "the survivor was merged again since" fall out of the *same* check for free rather than needing separate logic. Collection topology is restored as an explicit **split back**, never a blind copy: each side's own recorded pre-merge membership set is reinstated independently, so a collection both items belonged to gets both items back and one only the duplicate belonged to gets only the duplicate. Moved Activity events return to the recreated duplicate by exact id — verbatim, with their original timestamps, never synthesized as new "today" events — while any activity the survivor gained *after* the merge stays exactly where it is. A moved TrackingSource returns to the duplicate only if it's still pointed at the survivor; every other bit of that source's live state (`auto_track_enabled`, `last_detected_progress`, ...) is left untouched — Undo only ever reverses the *association*, never rewinds a source's own current status.

**Local mode is a full parity implementation**, not a stub: `lib/library-recovery.ts` holds the pure validate-then-restore logic (mirroring the RPCs' checks against in-memory state instead of a locked row), `lib/local-recovery-storage.ts` is a `markly.recovery` localStorage store with the same opportunistic-expiry-sweep behavior, and `lib/recovery-orchestration.ts` ties both modes together behind one call site used by both `LibraryView` and `ItemDetailView`. Confirmed (Section 27): local mode has no TrackingSources concept at all — Stage 22 pairing is cloud-only — so local delete/merge-undo only ever deals with LibraryItems, Collections, and Activity.

**UI**: a minimal from-scratch `UndoToast` (no toast/notification infrastructure existed in the codebase before this stage) appears after a successful Delete or Merge, with an Undo button and a five-to-eight-second auto-dismiss. Deleting from the item detail page navigates away immediately, so its toast can't simply persist there — the recovery id is handed off through `sessionStorage` (`setPendingUndoToast`/`takePendingUndoToast`, same-tab, one-shot, cleared on read) and picked up by the Library page on mount. **Settings → Recently Changed** (`/settings/recovery`) is a short list of the current user's still-undoable actions — deliberately not a full Trash page, since anything past 15 minutes simply isn't there to browse.

**Not implemented (deliberately out of scope for this stage):** Undo for anything other than Delete/Merge — no favorites/ratings/status/edit history, no AniList sync reversal, no browser-progress rollback, no permanent Recycle Bin, no general versioning; a resolution UI for a recovery conflict (it fails closed with an explanation instead, exactly like a blocked merge already does).

**Deployed and validated against real Postgres across 0010–0012** (all three security-review rounds and defect fixes described in their own migration doc comments): the FOR UPDATE/RLS interaction that originally broke Undo for every real user, the direct-INSERT/UPDATE recovery-forgery vulnerability (closed via SECURITY DEFINER on the two mutating RPCs plus dropping the INSERT policy entirely — recovery rows are now genuinely client-write-proof), SECURITY DEFINER search_path hardening, and the clock-skew-dependent Activity-conflict check (replaced with the same exact-id-set comparison technique already proven for collections).

## Portable Backup, Export & Import (Stage 29)

Settings → Data & Backup lets a user download their entire Markly library as one JSON file, and later restore or add to a library from one — a portability feature, not a sync/scheduled-backup product (see "Not implemented" below).

**The backup is a versioned, explicit contract** (`types/backup.ts`), never a raw dump of database rows: `{format: "markly-backup", version: 1, exportedAt, backupId, data: {libraryItems, collections, activityEvents}}`. Every field is deliberately listed so an internal schema change can never silently change what a backup contains. **Deliberately excluded**: TrackingSources (cloud/browser-tracking-specific, no local-mode equivalent, and a unique `(user_id, adapter_id, source_key)` constraint a foreign import could collide against — stated plainly in the UI: "Automatic tracking connections are not included"), `anilistSync` metadata (sync-diff bookkeeping relative to *this* account's AniList connection — portable `catalogSource` identity is kept, but reimporting stale sync-baseline into a different account or after reconnecting would misinform future conflict detection), every extension-device/pairing-code/OAuth-token table, and every `user_id`/ownership field. Backup ids (`backupItemId`, `backupCollectionId`) exist only within one file — the current LibraryItem/Collection id is reused as a convenient backup-local key at export time, but import never treats it as proof of identity and always remaps to freshly-created ids; reusing a real database UUID across two different accounts is unsafe by construction (global UUID space, and cloud RLS/ownership must never trust a client-supplied id regardless).

**Export** builds the same typed `LibraryItem[]`/`Collection[]`/`ActivityEvent[]` shapes the app already uses (`lib/backup/export.ts`), so one function serves both modes. One real gap found during Phase 0: `fetchActivityEvents` (the app's normal cloud hydration path) caps at 500 rows — a Recent Activity *display* limit, not a backup-completeness guarantee. Reusing that already-loaded state for export would have silently truncated history for any account with more activity than that. `lib/cloud/backup.ts` runs its own uncapped query instead (bounded only by Stage 29's own much larger record limit). Export consistency: three independent queries, not one transactional snapshot — considered and rejected a server-side snapshot RPC for this, since the only failure mode read-time drift could cause (a relationship pointing at a row the other query didn't happen to include yet) is already safely handled by import's own dangling-reference tolerance, the same tolerance a slightly-stale or hand-edited file needs anyway. Before ever being offered for download, the built object is run through the exact same validator import uses (`buildAndValidateBackup`) — Markly will never let you download a backup it considers invalid.

**Import is untrusted input, always.** `lib/backup/validate.ts` never does `JSON.parse → cast → insert`: every field is read as `unknown` and independently checked, reusing the app's own normalizers (`lib/tracking.ts`, `lib/website.ts`'s `isValidUrl`) rather than a second implementation. Two tiers of failure: STRUCTURAL problems (wrong format, a version newer than this app supports, a root that isn't shaped like the format at all, or a record count over the hard limit) reject the *whole* file — there's no safe partial reading of a file whose basic shape is wrong. Per-RECORD problems (one item with a `javascript:` URL, an Activity event with an unparseable timestamp, a dangling relationship to a missing backup item) drop just that record and continue, mirroring `lib/library-storage.ts`'s existing "clamp or drop, never fail the whole array" local-storage convention. A file whose records are *all* invalid is treated as damaged, not a suspiciously-empty success. Malformed timestamps are never replaced with "now" — that would falsify history. Limits (`lib/backup/limits.ts`): 15 MB file size (checked against `File.size` before any parsing), 5,000 LibraryItems, 200 Collections, 50,000 Activity events — generous above any realistic real library, bounding worst-case parse/DB work.

**Duplicate classification reuses Stage 27's own conservative signals** (`lib/duplicate-detection.ts`'s approach, `lib/title-normalization.ts` verbatim) rather than inventing new ones — never fuzzy, never automatic merging. A `catalogSource` match (same media type, same provider + externalId) is **already present** — an authoritative identity match, safe enough to attach the imported Collection membership onto the existing item. An exact-normalized-title match with no catalog conflict is only a **possible duplicate** — the exact same signal Stage 27 groups for user review, but never safe enough to silently attach anything to; skipped by default, and even when the user opts in (a single "Import possible duplicates too" checkbox, default off), it's created as a genuinely separate new item, never mapped or merged — Stage 27 Merge remains the only place two items are ever combined, and only by explicit user action there. Website items use an exact-normalized-URL match instead (their own authoritative identity signal; Stage 27's detector only ever considers media items). Collections reuse by exact (trimmed, case-insensitive) name — there's no uniqueness constraint on `collections.name` in the schema, so this is an app-level heuristic, not a database guarantee.

**Repeated-import idempotency needed no new provenance table for LibraryItems or Collections** — reclassifying against current state on each import naturally turns a previously-imported item into "already present" the next time the same file is imported, and `collection_items`' composite primary key (plus the `ON CONFLICT DO NOTHING` every write path here already uses) makes membership re-insertion safe by construction. **Activity is different**: `activity_events` has no equivalent natural uniqueness, so re-attaching imported history to an already-present item's mapping on a second import would duplicate that history every time. The fix needed no provenance table either — Activity is imported *only* for items with action "create" (never for an already-present mapping, even though that mapping is trusted enough for Collections), both in the plan builder (`lib/backup/plan.ts`) and re-enforced independently inside the cloud RPC itself (never trusting the client's plan for this).

**Cloud import is one transactional RPC** (`import_library_backup`, `supabase/migrations/0013_stage29_backup_import.sql` — **deployed and validated against the real database**), receiving a normalized import plan rather than the raw file — the server still independently re-verifies everything a client claim could get wrong that actually matters for security: every "already present"/"reuse" id the plan references is re-checked to belong to `auth.uid()` before it's used for anything, record-count limits are re-enforced (defense in depth — "client validation is not security"), and `user_id` on every inserted row is always `auth.uid()` (the portable format has no owner field to begin with). Runs `SECURITY INVOKER`, not DEFINER — unlike Stage 28's recovery table, every table this RPC writes to (`library_items`, `collections`, `collection_items`, `activity_events`) already has a working INSERT policy for `authenticated` that the existing app UI already uses directly, so there's no privilege gap to bridge. **Double-submit** (an accidental double-click, a client retry after a network hiccup) is closed by a minimal `backup_import_requests` table (id + user_id + created_at, nothing else, RLS-scoped, no update/delete policy, `primary key (user_id, id)` — deliberately user-scoped, never a global id) — the RPC's first write is `insert ... values (p_request_id, auth.uid())`, and a second call with the same client-generated request id hits that primary key and returns a clean `duplicate_request` status instead of creating anything twice. **Concurrent imports for the same user are serialized** by a transaction-scoped `pg_advisory_xact_lock` (the same idiom Stage 22's auto-add and Stage 28's recovery RPCs already use), and every "new" candidate is re-validated against the database's current state — not the client's possibly-stale classification — before being created, so two independently-submitted concurrent imports of the same backup can never race-create two copies of the same item (`supabase/migrations/0014_stage29_backup_import_fix.sql` — drafted, reviewed, **not yet deployed**, pending approval; also fixes two other live-discovered defects — a temp-table cleanup bug and a request-id consumed by a rejected oversized plan).

**Local mode builds the complete resulting state in memory first** (`lib/backup/apply-local.ts`) — next items, next collections, next Activity — and only commits all three localStorage stores in the same synchronous batch (`replaceAllLocal` on each of the three hooks), the same ordering lesson Stage 27's local-merge bug already taught: never let one store update while another still references something that hasn't caught up yet. localStorage itself still isn't transactional (three separate `setItem` calls) — a documented limitation, not a pretended-away one.

**Not implemented (deliberately out of scope for this stage):** CSV import/export, MyAnimeList/Goodreads/Trakt/OPML import, ZIP or password-encrypted backups, scheduled/automatic cloud backup, Google Drive/Dropbox/OneDrive sync, TrackingSource restoration, `external_connections` export, a "delete imported items" rollback feature (a transactional import already guarantees success-or-nothing; Stage 28 Undo was deliberately not extended to cover a whole import), and a general audit/event-sourcing platform (the one provenance table that does exist, `backup_import_requests`, is scoped to nothing but double-submit prevention).

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
  verify-video-tracking.mjs  Standalone check for the completion observer, primary-video selection,
                  and discovery-vs-commit auto-tracking model (see "Episode/Video Tracking" above) —
                  run with `node scripts/verify-video-tracking.mjs`
  verify-season-tracking.mjs  Standalone check for the season+episode comparison RPC, season-aware
                  Auto-Add/Activity/quick-increment behavior, and AniList isolation (see "Season-Aware
                  Episode Tracking" above) — run with `node scripts/verify-season-tracking.mjs`
  verify-source-management.mjs  Standalone check for cross-source progress (two sources, one item),
                  the manual-unlink auto-link-suppression logic, disabled-source enforcement, and the
                  friendly-name/progress-formatting/Open-Source-safety display helpers (see
                  "Cross-Source Work Identity" above) — run with `node scripts/verify-source-management.mjs`
  verify-duplicate-merge.mjs  Standalone check for conservative duplicate detection, the field-merge
                  policy (progress-furthest-wins, seasonal lexicographic, numbering/unit/catalog conflict
                  blocking), relationship transfer, and the merge RPC's ownership/lock-ordering/server-
                  authoritative-progress control flow (see "Safe Duplicate Detection & Manual Merge"
                  above) — run with `node scripts/verify-duplicate-merge.mjs`
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
