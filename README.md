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
- Persistent storage via the browser's `localStorage`, including safe handling of missing or malformed stored data
- Light and dark themes that respect the system preference on first visit, with the choice remembered afterward
- Responsive layout for desktop, tablet, and mobile

## Tech Stack

- [Next.js](https://nextjs.org/) (App Router)
- [React](https://react.dev/)
- [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS](https://tailwindcss.com/)

No backend, database, or authentication is used — Markly is intentionally a small, self-contained, client-side application.

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

Markly stores bookmarks in the browser's `localStorage`, under the `markly.bookmarks` key. The chosen theme is stored separately under `markly.theme`. This means:

- Data is stored per browser, per device — there is no account or cloud sync.
- Clearing your browser's site data for Markly will remove your saved bookmarks.
- Opening Markly in a different browser or device starts with a fresh set of starter bookmarks.

## Environment Variables

None. Markly has no backend and does not require any environment configuration to run.

## Project Structure

```
src/
  app/            Next.js App Router entry point (layout, page, global styles, icon)
  components/     UI components (bookmark cards, dialogs, filters, forms, theme toggle, etc.)
  data/           Starter/mock bookmark data used on first visit
  lib/            Pure helper functions (filtering, sorting, categories, storage, validation)
  types/          Shared TypeScript types
```

## Future Improvements

Possible directions beyond the current local-only version:

- User accounts with cloud synchronization
- Bookmark import/export
- A companion browser extension
