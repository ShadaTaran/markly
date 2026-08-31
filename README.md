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

## Project Structure

```
src/
  app/            Next.js App Router routes (/, /library, /library/[id], /login, /signup, layout, global styles, icon)
  components/     UI components (item cards, dialogs, filters, forms, theme toggle, auth, etc.)
  data/           Starter/mock library data used on first visit
  hooks/          Local/cloud-aware data hooks (useLibraryItems, useCollections, useActivity, useLocalImport)
  lib/            Pure helper functions (filtering, sorting, storage, validation, activity formatting)
  lib/cloud/      Supabase data-access + row/LibraryItem mapping + local→cloud migration
  lib/supabase/   Supabase browser/server client factories and env config
  types/          Shared TypeScript types
supabase/
  migrations/     SQL schema + Row Level Security policies for the optional Supabase backend
```

## Future Improvements

- OAuth sign-in (Google/GitHub/etc.)
- Bookmark/library import/export
- A companion browser extension
- Offline conflict resolution for account mode (currently last-write-wins with no merge)
