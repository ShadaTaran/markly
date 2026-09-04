# Markly Auto Tracking (Browser Extension)

Chrome/Chromium, Manifest V3. Automatically advances a Markly LibraryItem's
progress when you navigate a supported reading page. See the main repo's
[README.md § Auto Tracking](../README.md#auto-tracking-browser-extension)
for the full product explanation, pairing flow, and privacy model — this
file covers building and developing the extension itself.

**Status:** detection has two paths. A **universal detection engine**
(`src/tracking/universal/`) tries first on every page in scope, using
generic signals (URL pattern, headings, title, metadata, navigation) — no
site-specific adapter required. The one adapter that exists,
`markly-test-reader`, matches only Markly's own controlled test page at
`/dev/reader-test` and exists to prove the detection → link → auto-update
pipeline through an adapter specifically, not to be a real feature. A
second controlled page, `/dev/reader-test-generic`, has no adapter and no
Markly-specific markup at all — it exists to prove the universal engine
doesn't secretly depend on either.

**Stage 19 real-site result: NovelPhoenix works through `universal-reader`
alone — no adapter was created.** Tested live against 3 chapter URLs
across 2 novels (`novelphoenix.com/novel/lord-of-the-mysteries/chapter-1`,
`.../chapter-2`, `novelphoenix.com/novel/reverend-insanity/chapter-100`):
every page produced a correct `TrackingDetection` (right title, right
chapter, a source key stable across chapters) straight from the generic
engine. Two genuine, generic bugs turned up along the way and were fixed
in the universal engine itself (never NovelPhoenix-specific code — see
"Real-world title shapes" below): title extraction couldn't isolate a work
title from a label with extra trailing segments, and JSON-LD name lookup
could pick up a site-wide `Organization` block instead of skipping it.
Neither fix touches adapter code at all. See the Stage 19 report for the
full signal-by-signal breakdown.

## Real-world title shapes

A synthetic test page tends to label itself just `"Work Title - Chapter N"`.
Real sites rarely do — NovelPhoenix's `document.title`/`og:title` is
`"Lord of the Mysteries - Chapter 1 - Crimson - Novel Phoenix"`: the work
title, then the chapter marker, then the chapter's own name ("Crimson"),
then the site's name, all separator-joined. `extractWorkTitleFromLabel` in
`src/tracking/universal/detect.ts` isolates just the work title by finding
which separator-delimited segment contains the chapter/episode marker and
keeping only what comes before it (or, if the marker leads with nothing
before it, whatever segment comes right after) — discarding every segment
after the marker unconditionally. This handles "title - marker - extra -
extra", "marker | title", and "title marker" (no separator at all) with
the same logic; a trailing plain number that isn't itself a chapter/episode
marker (`"Lord of Mysteries 2"`) is never touched. See
`scripts/verify-title-extraction.mjs` at the repo root for the exact cases
covered, including the real strings captured from NovelPhoenix.

## Runtime site permissions

The extension never requests `<all_urls>` and never pre-declares a real
site's origin in `host_permissions`. `manifest.json` declares a wildcard
scheme-and-host pattern under `optional_host_permissions` — this is what
lets `chrome.permissions.request()` ask for one *specific* origin at
runtime; Chrome still prompts the user for exactly that origin, nothing
broader, and only when the request happens inside a genuine user gesture.

- `src/lib/site-permissions.ts` wraps `chrome.permissions.contains` /
  `.request` / `.remove` / `.getAll` — the only source of truth for "is
  this origin enabled," never a stored preference that merely claims to
  reflect it.
- `src/lib/config.ts`'s `isWithinTrackedScope()` is now async: the Markly
  dev origin is always in scope (required `host_permissions`), every other
  origin only if `chrome.permissions.contains` says so.
- The popup (`src/popup/popup.ts`) checks the active tab's origin (via the
  `activeTab` permission, which needs no install-time prompt) and shows
  "Tracking isn't enabled for this site" + an **Enable Tracking** button
  when it isn't. The button's click handler calls
  `chrome.permissions.request()` directly — synchronously within the
  gesture — then asks the service worker to inject the content script into
  the *current* tab immediately (`INJECT_NOW`), since the page already
  finished loading before the grant existed and `chrome.tabs.onUpdated`
  won't fire again on its own.
- `src/options/` is a minimal options page (`chrome.runtime.openOptionsPage()`,
  linked from the popup's "Manage Sites" button) listing every granted
  origin with a **Disable** button that calls `chrome.permissions.remove`.
  Not a general permissions dashboard — just enough to see and revoke what
  auto-tracking can reach.

**Site permission and source mapping are different concepts, kept
separate everywhere:** site permission ("may Markly inspect this site's
pages at all") lives entirely in Chrome's own permission store, checked
via `chrome.permissions`; source mapping ("which LibraryItem does this
specific detected work correspond to") lives in the `tracking_sources`
table server-side. Revoking a site's permission stops detection outright
(the content script is never injected there again); it has no effect on
any existing `tracking_sources` row, which stays linked and simply stops
receiving new detections until the site is re-enabled.

## Optional zero-touch auto-add (Stage 22)

`src/popup/popup.ts`'s `statusLineFor()` distinguishes three cases for an
otherwise-identical `updated`/`unchanged` API response, using two flags the
server sets at most once per source (see repo-root README "Optional
Zero-Touch Auto-Add" for the full server-side design):

- `autoAdded: true` — this exact request just auto-created the LibraryItem.
  Shows "✓ Added to Markly" plus a "Tracking automatically" subline.
- `autoLinked: true` — this exact request just linked to an *existing*
  item (Stage 18's smart-auto-link, or Stage 22's advisory-lock recheck
  finding one). Shows "✓ Tracked automatically", no subline.
- Neither flag — an already-linked source's routine update. Shows
  "✓ Tracked".

Both flags are one-time by construction (the server only ever sets them on
the literal request that changed something), so the popup needs no extra
state of its own to avoid repeating "Added to Markly" on every later
chapter — the same request-scoped pattern `autoLinked` already used before
this stage.

The "Automatically add new works" preference itself has **no popup UI** —
it's set only from Settings → Auto Tracking on the web, per device. This
was a deliberate choice, not an oversight: the per-source
`auto_track_enabled` toggle already established that precedent (web-only),
and a second toggle surface for the same rarely-changed boolean would only
risk it drifting out of sync with the persisted value — see the root
README for the reasoning.

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
                    "universal-reader"; extractWorkTitleFromLabel handles
                    real-world page-label shapes (see "Real-world title
                    shapes" above)
    diagnostics.ts Dev-only: recomputes the same signals to explain a
                    decision (console.debug only — never sent anywhere,
                    never shown in the ordinary popup UX)
  background/
    service-worker.ts   Owns the device token, calls the Markly API, injects
                          the content script on any tab within tracked scope
                          (isWithinTrackedScope — not tied to a specific
                          adapter matching), tracks per-tab detection state
                          for the popup, handles INJECT_NOW (immediate
                          injection right after a fresh permission grant)
  content/
    content-script.ts   Injected on any in-scope tab. Checks the adapter
                          registry first; if one matches the URL, uses that
                          adapter's result exclusively (even if null) —
                          otherwise falls back to universal detection.
                          Always reports its result (even null, so the
                          popup can distinguish "nothing confidently
                          detected" from "never ran"). Reads the page,
                          forwards at most one message, and does nothing
                          else.
  popup/
    popup.html/css/ts   Plain DOM, no framework — pairing form, per-site
                          "Enable Tracking" prompt, or current-page status
                          depending on connection/permission state
  options/
    options.html/css/ts Plain DOM options page — lists granted site
                          permissions with a Disable button each
  lib/
    config.ts    MARKLY_BASE_URL (hardcoded to localhost for Stage 18) and
                  isWithinTrackedScope() — the injection gate, kept
                  deliberately separate from adapter-vs-universal selection
                  so universal coverage never requires broader permissions
                  than one origin at a time
    site-permissions.ts  chrome.permissions wrapper (see "Runtime site
                  permissions" above) — the only source of truth for
                  which third-party origins are enabled
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

## Real-world manga tracking (Stage 23)

`src/adapters/mangadex.ts` is a worked example of the guidance above,
written only after confirming universal detection genuinely couldn't reach
its own confidence threshold there (zero heading elements, no numeric
chapter in the URL — see the root README's "Real-World Manga Tracking"
section for the full live-inspection findings, including a real post-
deploy bug fix: `og:title` never updates on MangaDex's client-side
navigation, so it's deliberately not used at all — `document.title` is the
sole chapter-number source, and work identity/title comes from the page's
own `/title/<uuid>/<slug>` anchor instead). It's deliberately thin:
`parseProgressText` and `buildDetectedMetadata` are reused verbatim from
`tracking/universal/`, not reimplemented.

Two pieces of this stage are generic, not MangaDex-specific, and apply to
any future site:

- **`tracking/universal/site-capability.ts`** — a small hostname → media-
  type lookup, for a page universal detection *can* confidently read on
  its own but whose "chapter" is ambiguous between manga and novel. Not a
  substitute for an adapter when the real problem is detection confidence
  itself, as it was for MangaDex — see the module's own doc comment for
  the distinction.
- **SPA navigation support in `content-script.ts`** — a `history.pushState`/
  `replaceState`/`popstate` listener, debounced 600ms, that re-runs
  detection when a client-side router changes the URL without a full page
  reload. Verified necessary and working against MangaDex's real Vue
  Router-based reader; benefits any other client-side-routed site for
  free, with no site-specific code.

## Episode/video tracking (Stage 24)

`src/tracking/video/completion.ts` is the one place completion-threshold
logic lives — primary-video selection and the watch-completion observer
are both fully generic; no adapter ever implements its own version of
either. An episode-kind (`progress.kind === "episode"`) detection in
`content-script.ts` sends an immediate discovery ping
(`TRACKING_DETECTED` with `commit: false` — establishes identity/Smart
Auto-Link/Auto-Add without committing progress) and then, only if a
confident primary `<video>` can be found, attaches a completion observer;
its `onComplete` callback sends a second, ordinary `commit: true`
detection once eligible. See the root README's "Episode/Video Tracking"
section for the full completion policy, the real Crunchyroll
investigation (concluding no dedicated adapter — the player is
inaccessible without login regardless of title-parsing), and the
`/dev/video-test/episode-N` harness.

The service worker's dedup (`background/service-worker.ts`) is split into
two independent caches for this reason: a discovery ping and its eventual
completion carry the *same* episode number, and conflating "already
mentioned this value" with "already committed this value" would let a
discovery ping silently swallow the real completion send.

## Season-aware episode tracking (Stage 25)

A season transition (S1E12 → S2E1) drops the raw episode number, which the
Stage 18/24 numeric compare-and-set can't tell apart from real regression.
`TrackingProgress` gains an optional `season?: number`, read only when
`progress.kind === "season_episode"` — every other kind (including plain
`"episode"`) never sets it, so this widens the existing wire shape rather
than replacing it; every kind/value-only consumer written before Stage 25
(`formatProgress` in `popup.ts`, the service worker's dedup) keeps
compiling and working unchanged.

`isEpisodeProgressKind()` (`adapters/types.ts`) is `true` for both
`"episode"` and `"season_episode"` — `content-script.ts`'s episode-vs-
chapter branch, and the video completion pipeline it gates, apply
identically to both; only how the *value* is interpreted server-side
differs (see the root README's "Season-Aware Episode Tracking" for the
database-side lexicographic comparison). The active-observer/discovery
identity key is now season-qualified (`s2e3` vs. plain `3`) so a season
transition to the same in-season episode number as a prior season is never
mistaken for "still watching the same episode" and left un-reset.

`markly-season-test.ts` is a new, permanent, narrowly-scoped adapter
(matches only Markly's own dev origin, mirroring `markly-test-reader.ts`'s
role) that reads `/dev/video-test/show/season-N/episode-M` and emits a
`{kind: "season_episode", season, episode}` detection — proving the wire
shape and the atomic seasonal RPC without a real streaming provider, which
this stage deliberately doesn't add (no generic season parsing was added
to universal detection either — no real-world evidence backs a generic
season URL/heading shape the way Stage 23's chapter/episode patterns had).

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
  sent well-formed or honest data. A null detection (nothing confidently
  found) never reaches this endpoint at all — it's reported to the service
  worker purely as local popup state (see content-script.ts above).
- Diagnostics (`tracking/universal/diagnostics.ts`) read exactly the same
  narrow signal set `detectUniversal` already reads — never more — and are
  only ever written to `console.debug` in the page's own DevTools console.
  They are never included in the message sent to the service worker, never
  forwarded to Markly, and never rendered in the popup.
- Site permission grants are Chrome's own, checked live via
  `chrome.permissions` — nothing about which sites are enabled is ever
  cached in a way that could go stale relative to what Chrome actually
  granted (see "Runtime site permissions" above).
