# Markly

A single library for everything you're reading, watching, or playing — anime, manga, novels,
movies, series, games, and bookmarked websites — with progress tracking that follows you across
devices when you sign in.

**Live:** [markly-lime.vercel.app](https://markly-lime.vercel.app)
**Status:** Beta / Portfolio Demo — currently shared directly (recruiters, interviewers, direct links) rather than launched for public signup.

## Core Features

- **Universal library** — every content type in one place, one dashboard, one search.
- **Continue where you left off** — a dashboard built around what you're currently in progress on.
- **Automatic tracking, manual fallback** — an optional browser extension advances progress on
  compatible reading/watching sites; everything else is a simple manual update. Tracking never
  guesses: a wrong automatic update is treated as worse than a missed one.
- **Catalog search** — look up anime/manga (AniList) and books (Open Library) instead of typing
  everything by hand. Movie/Series (TMDB) and Game (RAWG) catalog search use the same mechanism
  but need their own API keys configured per deployment; manual entry always remains available for
  every content type regardless.
- **Reminders** — optional browser push notifications, off by default.
- **Backup & restore** — export your full library as one JSON file; import it back, or into a
  different account, with conservative duplicate detection.
- **Undo for destructive actions** — a 15-minute recovery window for delete and merge.
- **Local mode** — usable with no account at all; your library lives in the browser until you
  choose to sync it.
- **Data ownership** — export anytime; permanently delete your account and its cloud data from
  Settings.
- **PWA** — installable, works offline for what's already loaded.

## Supported Content Types

Anime, Manga, Novels (books, light novels, and web novels as a lighter-weight category), Movies,
Series, Games, and bookmarked Websites.

## Architecture

```
Browser (Next.js App Router, React, PWA)
        │
        ├── Local mode: localStorage only, no network
        │
        └── Account mode
                │
                ▼
        Supabase (Postgres + Auth, Row Level Security)
                ▲
                │
   ┌────────────┼─────────────────┐
   │            │                 │
Browser      AniList          Metadata
Extension   (optional,      providers (optional:
(device-    OAuth +          TMDB, RAWG,
token auth, manual           Open Library,
not a       sync/writeback)  AniList search)
Supabase
session)
```

The web app and the browser extension are the only two clients. The extension never receives a
Supabase session — it authenticates with its own device token (paired once from the app), and the
one server-only admin client that bypasses Row Level Security for it independently re-derives and
re-scopes every query to that token's owner. Every other route in the app uses the ordinary
session-based Supabase client, with Row Level Security enforced normally.

## Technology Stack

- [Next.js](https://nextjs.org/) (App Router) + [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Supabase](https://supabase.com/) (Postgres + Auth) — optional; local mode needs no backend at all
- A Manifest V3 Chrome extension ([`extension/`](./extension)) for automatic progress detection
- Web Push (`web-push`) for optional reminder notifications

## Tracking Architecture

Three ways progress gets updated, in order of how much Markly can verify:

1. **Official/provider APIs** — AniList sync (manual "Sync Now," never automatic or background)
   for anime/manga already tracked there.
2. **Browser extension** — a universal detection engine reads page structure (headings, URL
   patterns, document title, structured metadata) on pages you've explicitly enabled, with
   site-specific adapters only where generic detection genuinely can't cope (e.g. MangaDex's
   reader has no heading elements at all). Detections only ever **advance** progress — concurrency
   is resolved by a row-locking Postgres function, never trusted from a single request.
3. **Manual fallback** — always available, for every content type, whether or not automatic
   tracking exists for that source.

See [`extension/README.md`](./extension/README.md) for the full detection design.

## Data Ownership & Privacy

- **Local mode** never leaves your browser.
- **Account mode** is isolated per user via Postgres Row Level Security.
- **Export** your full library as JSON anytime (Settings → Data & Backup).
- **Delete your account** anytime (Settings → Account) — a single call cascades every Markly
  cloud table for that user in one Postgres transaction; local-mode browser data and downloaded
  backups are untouched by this, since neither ever left the device.
- **AniList tokens** are encrypted at rest (AES-256-GCM) and never sent to the browser.
- No ads, no analytics/tracking pixels, no selling of data.

Full details: [markly-lime.vercel.app/privacy](https://markly-lime.vercel.app/privacy) and
[/terms](https://markly-lime.vercel.app/terms).

## PWA / Push

Markly is installable (manifest + service worker + icons). Reminders can optionally deliver as
Web Push notifications; enabling this is per-device and always opt-in.

## Development Setup

Prerequisites: Node.js 20.9+.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). With no environment variables set, Markly
runs entirely in local mode — every core feature works against `localStorage`, no backend
required.

```bash
npm run build   # also type-checks
npm start
npm run typecheck
npm run lint
```

## Environment Variables

Names only — see [`.env.example`](./.env.example) for what each one is for and where to get it.
**Never commit real values.**

| Variable | Required for |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Accounts / cross-device sync |
| `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`) | Browser extension device-token API (server-only) |
| `TMDB_API_KEY` | Movie/Series catalog search |
| `RAWG_API_KEY` | Game catalog search |
| `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET`, `ANILIST_REDIRECT_URI` | AniList connected accounts |
| `MARKLY_INTEGRATION_ENCRYPTION_KEY` | Encrypting stored AniList tokens |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push reminders |
| `PUSH_CRON_SECRET` | Authorizing the scheduled due-reminder processor |

Every one of these is optional — Markly degrades gracefully (local mode, or a plain "not
configured" message on the specific feature) with any subset unset.

## Database Migrations

SQL lives in [`supabase/migrations/`](./supabase/migrations), numbered and applied in order.
Migrations `0001`–`0019` are production-applied and immutable; any future schema change starts at
`0020`. Run them against your own Supabase project via the Dashboard's SQL Editor or
`supabase db push`.

## Extension Setup

```bash
npm run extension:build    # or extension:watch during development
```

Load `extension/dist/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode
→ Load unpacked). Pair it from Settings → Auto Tracking in the running app. Full detail in
[`extension/README.md`](./extension/README.md).

## Verification / Testing

Each major feature has a standalone `node`-runnable verification script under
[`scripts/`](./scripts) (no test framework — plain assertions), e.g.:

```bash
node scripts/verify-account-lifecycle.mjs
node scripts/verify-public-launch.mjs
```

There are 31 such scripts as of Stage 45, covering everything from atomic progress updates and
smart auto-linking to account deletion, backup import, and public-launch surface correctness.

## Security Notes

- Every session-authenticated route derives identity from `supabase.auth.getUser()` — never a
  client-supplied user id.
- The one server-only admin client that bypasses Row Level Security (`src/lib/supabase/admin.ts`,
  gated by the `server-only` package) is used in exactly the routes the extension needs, each one
  independently re-scoping every query to the token-derived user.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, `poweredByHeader: false`) are set project-wide.
- A Content-Security-Policy is a deliberately deferred, dedicated future hardening task — see the
  Stage 44 hardening notes in `next.config.ts`.

## Known Limitations

- No custom SMTP configured in production yet — Supabase's default email service is acceptable for
  low-volume portfolio testing but has low sending limits, and is not production-ready for a
  broader public beta. See [`docs/PUBLIC_BETA_CHECKLIST.md`](./docs/PUBLIC_BETA_CHECKLIST.md).
- Game and Movie/Series catalog search require `RAWG_API_KEY`/`TMDB_API_KEY`, which aren't
  configured in every deployment; when absent, search degrades to a plain message and manual entry
  remains fully available.
- No CSP yet (deliberately deferred, see above).
- No OAuth sign-in for Markly itself (email/password only); no offline conflict resolution beyond
  last-write-wins; no Firefox/Edge extension build.

## Roadmap

Currently deployed as a portfolio/demo build — shared directly rather than launched for public
signup or search discovery. See [`docs/PUBLIC_BETA_CHECKLIST.md`](./docs/PUBLIC_BETA_CHECKLIST.md)
for what's still required before a broader public beta.

## License

No license file exists in this repository yet — until one is added, all rights are reserved by
default. This is a beta project; a license (or a decision to keep the source private) is still
pending.
