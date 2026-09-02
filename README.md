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

The extension requests only `storage` (to hold the device token and per-tab status) and `scripting` (to inject a content script only on tabs within `host_permissions` scope — the content script itself then picks an adapter or falls back to universal detection, see "Architecture" above) plus `host_permissions` for `http://localhost:3000/*` — the only enabled origin while only test pages exist. It does **not** request `<all_urls>`, `cookies`, `webRequest`, or `tabs`, does not read passwords or login forms, does not send full page HTML or unrelated page content to Markly (only h1/h2 text, title, a handful of metadata tags, and prev/next link hrefs are ever inspected), does not collect general browsing history, does not run on any page outside its granted scope, and does not sell or share browsing data with anyone — Markly's own servers are the only destination for any detection it sends, ever. Universal detection does not change this: it only changes *which* pages within the already-granted scope get tracked, never *how many* origins the extension can reach. A real Stage 19 site addition will request its own origin via `optional_host_permissions`, so enabling one site never grants access to another; an adapter for that site is added only where universal detection turns out to be unreliable for it.

### Current limitation

Only the `markly-test-reader` adapter exists, matching Markly's own controlled test page at `/dev/reader-test` (development/testing only, not a real feature). A second test page, `/dev/reader-test-generic`, deliberately uses ordinary reader-style markup with none of the first page's Markly-specific attributes, to prove universal detection works without relying on any site-specific selectors. Stage 19 adds the first real external-site adapter using the same `matches()`/`detect()` interface — see [`extension/src/adapters/`](./extension/src/adapters) — for a site where universal detection proves unreliable; sites where it works well may need no adapter at all.

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
  lib/cloud/      Supabase data-access + row/LibraryItem mapping + local→cloud migration
  lib/supabase/   Supabase browser/server client factories, env config, and the server-only admin
                  (Secret API Key) client used only by the extension-facing API
  lib/integrations/         Provider-neutral connection storage + token encryption
  lib/integrations/anilist/ AniList OAuth, GraphQL client, mapping, and sync engine
  lib/extension/  Device pairing, device-token/pairing-code hashing, the pairing-endpoint rate
                  limiter, tracking-source persistence (incl. the atomic first-link claim), smart
                  auto-linking (auto-link.ts), and the thin RPC wrapper (progress.ts) behind
                  /api/extension/progress — the concurrency-safe compare-and-write logic itself
                  lives in the database, see supabase/migrations/0004_*
  types/          Shared TypeScript types
scripts/
  verify-atomic-progress.mjs  Standalone concurrency check for the apply_extension_progress logic
                  (see "Progress safety" above) — run with `node scripts/verify-atomic-progress.mjs`
  verify-smart-auto-link.mjs  Standalone check for the auto-linking match rules and the concurrent
                  first-link claim (see "Source mapping" above) — run with `node scripts/verify-smart-auto-link.mjs`
supabase/
  migrations/     SQL schema + Row Level Security policies for the optional Supabase backend
extension/
  manifest.json   Manifest V3 — permissions, service worker, popup
  src/adapters/   Site adapter interface + registry (overrides/fallbacks for specific sites)
  src/tracking/universal/  Universal detection engine (default path — see "Architecture" above):
                  metadata.ts, url.ts, headings.ts, progress.ts, navigation.ts signal extraction,
                  confidence.ts scoring, detect.ts orchestration
  src/background/ Service worker — the only context that holds the device token or calls the Markly
                  API; injects the content script based on host_permissions scope only
  src/content/    Content script — picks adapter vs. universal detection, forwards the result;
                  never sees the device token
  src/popup/      Plain HTML/TS/CSS popup, no framework
  src/lib/        Extension-side storage/API/config (incl. the tracked-scope check) helpers
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
