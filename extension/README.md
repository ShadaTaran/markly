# Markly Auto Tracking (Browser Extension)

Chrome/Chromium, Manifest V3. Automatically advances a Markly LibraryItem's
progress when you navigate a supported reading page. See the main repo's
[README.md § Auto Tracking](../README.md#auto-tracking-browser-extension)
for the full product explanation, pairing flow, and privacy model — this
file covers building and developing the extension itself.

**Stage 18 status:** detection has two paths. A **universal detection
engine** (`src/tracking/universal/`) tries first on every page in scope,
using generic signals (URL pattern, headings, title, metadata, navigation)
— no site-specific adapter required. The one adapter that exists,
`markly-test-reader`, matches only Markly's own controlled test page at
`/dev/reader-test` and exists to prove the detection → link → auto-update
pipeline through an adapter specifically, not to be a real feature. A
second controlled page, `/dev/reader-test-generic`, has no adapter and no
Markly-specific markup at all — it exists to prove the universal engine
doesn't secretly depend on either. Stage 19 adds the first real
external-site adapter, for a site where the universal engine turns out to
be unreliable — see "Adding a new site adapter" below for when that's
actually warranted.

## Build

From the repo root:

```bash
npm run extension:build
```

Output goes to `extension/dist/` (gitignored — rebuilt from source, never
committed). For active development, rebuild on save:

```bash
npm run extension:watch
```

After a rebuild, reload the extension in `chrome://extensions` (the reload
icon on the extension's card) to pick up the change — the browser doesn't
watch the unpacked folder itself.

Typecheck the extension separately from the main Next.js app (its
`tsconfig.json` uses `chrome.*` types the app's typecheck doesn't need):

```bash
npm run extension:typecheck
```

## Load it in Chrome

1. `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked**
4. Select `extension/dist`

## Folder structure

```
manifest.json       Manifest V3: permissions, service worker, popup, host_permissions
tsconfig.json        Separate from the app's tsconfig — includes chrome.* types
scripts/build.mjs    esbuild bundler (three entry points, no framework)
src/
  adapters/
    types.ts               TrackingAdapter / TrackingDetection interfaces
    registry.ts             Every registered site-specific adapter, in one list
    markly-test-reader.ts   The one adapter that exists today (test page only)
  tracking/universal/
    metadata.ts   og:title / canonical / JSON-LD name extraction
    url.ts         /chapter-N, /ch-N, /cN, /episode-N, /ep-N, /eN path patterns
                    (+ the matched segment stripped, for stable source keys)
    headings.ts   First h1/h2 matching "Chapter N" / "Episode N"
    progress.ts   Shared "Chapter N"/"Episode N" free-text pattern, used by
                    both headings.ts and metadata-derived title text
    navigation.ts Finds Previous/Next links by text/rel/class, resolves
                    their href to an adjacent chapter/episode value
    confidence.ts Weighted, multi-signal scoring — the threshold and
                    "≥2 signals must agree" gate that keeps this engine from
                    firing on a single coincidental number (see main
                    README's "Universal detection signals" table)
    detect.ts      Orchestrates the above into one TrackingDetection or null;
                    exports the fixed detector id UNIVERSAL_DETECTOR_ID =
                    "universal-reader"
  background/
    service-worker.ts   Owns the device token, calls the Markly API, injects
                          the content script on any tab within tracked scope
                          (isWithinTrackedScope — not tied to a specific
                          adapter matching), tracks per-tab detection state
                          for the popup
  content/
    content-script.ts   Injected on any in-scope tab. Checks the adapter
                          registry first; if one matches the URL, uses that
                          adapter's result exclusively (even if null) —
                          otherwise falls back to universal detection. Reads
                          the page, forwards at most one message, and does
                          nothing else.
  popup/
    popup.html/css/ts   Plain DOM, no framework — pairing form or
                          current-page status depending on connection state
  lib/
    config.ts    MARKLY_BASE_URL (hardcoded to localhost for Stage 18) and
                  isWithinTrackedScope() — the injection gate, kept
                  deliberately separate from adapter-vs-universal selection
                  so universal coverage never requires broader permissions
    storage.ts   chrome.storage.local wrapper for the device token
    api.ts       The only module that calls Markly's API — imported by the
                  service worker only
  types/
    messages.ts  The content-script ↔ service-worker message protocol
```

## Adding a new site adapter (Stage 19+)

Try the site with universal detection first — enable its origin (see below)
with no adapter at all, and check whether it's already being tracked
correctly. Universal detection is the default path; an adapter is only
warranted when it isn't reliable for that specific site (inconsistent
heading markup, a URL scheme none of the patterns cover, a title format
`progress.ts` can't parse, etc.) — adapters exist as overrides for exactly
those cases, not as a prerequisite for support.

If a site does need one:

1. Create `src/adapters/your-site.ts` implementing `TrackingAdapter`
   (`matches(url)`, `detect(document, url)`).
2. Add it to the list in `src/adapters/registry.ts`.
3. Add the site's origin to `manifest.json` — for a real (non-localhost)
   site this should be `optional_host_permissions`, requested only when
   the user explicitly enables that adapter, not bundled into the base
   install's `host_permissions`.
4. Make `matches(url)` as narrow as the site actually requires — a prefix
   check broader than intended will silently claim URLs meant for other
   pages (including, during development, Markly's own
   `/dev/reader-test-generic` universal-detection test page) and keep
   universal detection from ever running there. Prefer an anchored regex
   (`/^\/reader\/(\/|$)/`) over `pathname.startsWith(...)` unless you've
   checked there's nothing else under that prefix.

Nothing in `background/` or `popup/` needs to change for a new adapter —
only `content-script.ts`'s existing adapter-first/universal-fallback logic
picks it up automatically once it's registered.

## Security notes for contributors

- The device token lives only in `chrome.storage.local`, restricted to
  `TRUSTED_CONTEXTS` (set once by the service worker on startup) — never
  webpage `localStorage`, never sent to the content script.
- `src/lib/api.ts` (the only module that calls Markly's API, and the only
  place the device token is ever attached to a request) is imported only
  by the service worker.
- The content script treats the page as untrusted input on both detection
  paths: the `markly-test-reader` adapter reads only its specific
  `data-markly-reader-*` attributes; the universal engine reads only a
  narrow, fixed set of DOM surfaces (h1/h2 text, `document.title`, a
  handful of `<meta>`/`<link>`/JSON-LD tags, and prev/next `<a>` hrefs) —
  never arbitrary page content, form fields, or scripts. Any string that
  ends up in the popup's UI is HTML-escaped before insertion either way (a
  page could otherwise inject markup into the popup via a crafted
  `data-source-title` or a crafted `og:title`).
- Every detection — from either path — is validated again server-side in
  `POST /api/extension/progress` — the extension is never trusted to have
  sent well-formed or honest data.
