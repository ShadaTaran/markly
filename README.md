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

Both are safe for client-side code — the anon key relies on Row Level Security, not secrecy, to protect data. Never put a Supabase **service-role** key in this project; it is never needed client-side and would bypass Row Level Security entirely.

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

## Project Structure

```
src/
  app/            Next.js App Router routes (/, /library, /library/[id], /login, /signup, /settings/connections, layout, global styles, icon)
  app/api/integrations/anilist/  Server-only AniList OAuth + import/sync route handlers
  components/     UI components (item cards, dialogs, filters, forms, theme toggle, auth, connections, etc.)
  data/           Starter/mock library data used on first visit
  hooks/          Local/cloud-aware data hooks (useLibraryItems, useCollections, useActivity, useLocalImport)
  lib/            Pure helper functions (filtering, sorting, storage, validation, activity formatting)
  lib/cloud/      Supabase data-access + row/LibraryItem mapping + local→cloud migration
  lib/supabase/   Supabase browser/server client factories and env config
  lib/integrations/         Provider-neutral connection storage + token encryption
  lib/integrations/anilist/ AniList OAuth, GraphQL client, mapping, and sync engine
  types/          Shared TypeScript types
supabase/
  migrations/     SQL schema + Row Level Security policies for the optional Supabase backend
```

## Future Improvements

- OAuth sign-in for Markly itself (Google/GitHub/etc. — distinct from the AniList connected-account feature above)
- Additional connected providers (Trakt, Steam) on the same connected-accounts architecture
- Background/automatic AniList sync (currently manual "Sync Now" only)
- Markly → AniList outbound writes (currently inbound-only)
- Bookmark/library import/export
- A companion browser extension
- Offline conflict resolution for account mode (currently last-write-wins with no merge)
