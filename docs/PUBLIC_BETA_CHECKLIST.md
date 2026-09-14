# Public Beta Checklist

Status as of Stage 45. An item is checked only when there's evidence for it (a
passing verification script, a live production test, or direct code
inspection) — not because it seems like it should work.

**Current release posture: Beta / Portfolio Demo.** Markly is deployed at
`https://markly-lime.vercel.app` and shared directly (recruiters, interviewers,
direct links) — not launched for public signup or search discovery. Items
below marked "not required for portfolio" are still tracked here because
they're required before a *broader* public beta, not because they block the
current posture.

## Auth

- [x] Sign up (email/password via Supabase Auth)
- [x] Email confirmation (required in production; `enable_confirmations: true`)
- [x] Resend confirmation (re-submitting sign-up with the same email re-triggers Supabase's own flow)
- [x] Log in
- [x] Log out
- [x] Forgot password / reset password (added Stage 45, application-level; accepted for the portfolio posture)
- [x] Account deletion (`/api/account/delete`, Stage 43)
- [ ] **Production auth email delivery** — see "Known Infrastructure Gaps" below; low-volume portfolio testing is acceptable once the Auth URL fix (below) is applied, but this is NOT production-ready for broad public signup

## Product

- [x] Library (add/edit/delete, search, filter, sort)
- [x] Progress tracking (manual + automatic via extension)
- [x] Auto Tracking (browser extension, Smart Auto-Link, Auto-Add)
- [x] Reminders (Stage 34) + Web Push delivery (Stage 37)
- [x] Backup export
- [x] Backup import
- [x] Search / Command Palette
- [x] PWA installability (manifest, icons, service worker)

## Security

- [x] Auth boundaries (every session route derives identity via `auth.getUser()`)
- [x] Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `poweredByHeader: false`)
- [x] Migration immutability (0001–0019 unchanged; no 0020)
- [ ] **CSP** — deliberately deferred (Stage 44); not required for portfolio, still required as a dedicated hardening task before any broader public beta
- [x] No secrets in the repository (checked every Stage 44/45 file diff)

## Infrastructure

- [x] Production URL: `https://markly-lime.vercel.app` (no custom domain — not being purchased for the portfolio posture)
- [ ] **Auth URL configuration (`site_url` / `additional_redirect_urls`)** — proposed exact configuration prepared this round (see the Stage 45 portfolio-reframe report), **not yet applied**. Recommended even for the portfolio posture, since it's what makes the existing confirmation/reset email links resolve to the real production origin instead of localhost.
- [ ] **Custom SMTP** — deferred; not required for portfolio-scale/low-volume use, but required before a broader public beta signup launch
- [ ] **RAWG/TMDB provider keys** — deferred; current graceful degradation ("Unable to search right now — you can still enter this item manually") is accepted for portfolio use
- [ ] **Custom domain** — none purchased; not required for portfolio
- [x] RAWG/TMDB unconfigured-state behavior confirmed non-blocking (verified in `MetadataSearchPanel.tsx`) — never a dead end regardless of posture
- [x] Web Push scheduler (`/api/push/process-due`, Stage 37 — unchanged)
- [x] AniList OAuth callback URL (unchanged, points at the deployed origin — independent of the Supabase Auth URL settings above, since it's configured separately via `ANILIST_REDIRECT_URI`)

## Public Surface

- [x] Landing page (signed-out `/`, first-time visitors only — Stage 45; CTA re-ordered this round so local exploration, not signup, is primary)
- [x] Privacy (`/privacy`)
- [x] Terms (`/terms`)
- [x] Support (`/support`)
- [ ] **Public indexing decision** — decided this round: remain unindexed (`Disallow: /`). Not required for portfolio (shared via direct link, not search); must be reconsidered before any future public/indexable launch
- [x] Metadata (title, description, Open Graph, Twitter card)
- [x] README (rewritten Stage 45, wording updated this round to "Beta / Portfolio Demo")
- [ ] **License decision** — no LICENSE file; deferred, not required for portfolio

## Release

- [x] Full verification suite passing (see Stage 45 final report for exact counts)
- [x] Production smoke-testable once deployed (not deployed this round)
- [x] No real user data used in any public copy, README, or fixtures
- [x] Git tree clean, nothing staged, at end of this round

## Known Infrastructure Gaps (required before a broader public beta; not all block the current portfolio posture)

1. **Auth URL configuration — recommended even for portfolio.** Production's Auth `site_url` is `http://localhost:3000` and `additional_redirect_urls` is empty. Any Supabase auth email link (today's signup confirmation, and the new password-reset flow) currently redirects to localhost for a real user. Proposed fix (not yet applied): set `site_url` to `https://markly-lime.vercel.app`, add `https://markly-lime.vercel.app/reset-password` and `https://markly-lime.vercel.app/**` to `additional_redirect_urls`, and keep `http://localhost:3000/**` in the allow-list so local development continues to work. No custom domain or SMTP change required for this fix.
2. **Custom SMTP — required before broad public beta, not before portfolio.** Production Supabase project has custom SMTP disabled (`auth.email.smtp.enabled: false`), meaning auth emails go through Supabase's shared, low-volume default service — the same one that produced the Stage 43 rate-limit incident. Acceptable for low-volume portfolio testing once (1) above is applied; not production-ready at real public-beta volume (50–100+ users).
3. **Public indexing posture.** robots.txt disallows all crawling — the deliberate portfolio-posture decision (shared by direct link, not discovered via search). Must be revisited before any future public/indexable launch.
4. **License.** No LICENSE file exists. Not invented — a public GitHub repository without one is "all rights reserved" by default. Deferred until an explicit decision is made.
5. **RAWG/TMDB provider keys.** Not configured. Current graceful degradation is accepted indefinitely for the portfolio posture; only relevant to revisit if a future public beta wants live Movie/Series/Game catalog search.
6. **Custom domain.** None purchased. Not required for either the current portfolio posture or a future public beta unless desired.
