import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/Button";

/**
 * Stage 45 — the signed-out, no-local-history `/` experience (see
 * SignedOutHomeGate for why this only shows to a genuinely first-time
 * visitor, never a returning local-mode user with real data). Every claim
 * below is deliberately scoped to what's actually implemented: "supports
 * automatic tracking on compatible sources, manual fallback elsewhere" —
 * never "tracks everything automatically" or similar absolutes.
 *
 * Portfolio-posture update — Markly is currently shared as a demo link
 * (recruiters, interviewers, direct shares) rather than launched for
 * self-serve signup, so the primary CTA is local exploration (no account,
 * no email, nothing to configure) with account creation as the secondary
 * path — not the other way around. Local mode is Markly's own real
 * feature, not a special demo build.
 */
const FEATURES = [
  {
    title: "One library for everything",
    body: "Anime, manga, novels, movies, series, games, and bookmarked websites, tracked in one place instead of scattered across apps.",
  },
  {
    title: "Continue where you left off",
    body: "The dashboard surfaces what you're currently in progress on, so picking back up never means hunting for it.",
  },
  {
    title: "Automatic tracking where it's supported, manual everywhere else",
    body: "An optional browser extension can advance progress automatically on compatible reading and watching sites. Everything else, you update by hand.",
  },
  {
    title: "Reminders, if you want them",
    body: "Optional browser push notifications for items you want to come back to. Off by default.",
  },
  {
    title: "Your data, your call",
    body: "Export a full backup at any time, or permanently delete your account and its cloud data, both from Settings.",
  },
  {
    title: "No account required to try it",
    body: "Local mode keeps your library in this browser with no sign-up. Create an account later if you want it synced across devices.",
  },
];

export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-16 sm:px-6">
        <div className="mb-10 flex items-center gap-2">
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-foreground">Markly</span>
          <span className="ml-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Beta
          </span>
        </div>

        <h1 className="text-3xl font-semibold tracking-tight text-balance text-foreground sm:text-4xl">
          Never lose your place again.
        </h1>
        <p className="mt-4 max-w-xl text-base text-muted-foreground">
          Markly is a single library for everything you&rsquo;re reading, watching, or playing —
          with progress that follows you across devices once you sign in.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3">
          <Link href="/library">
            <Button variant="primary">Explore Markly</Button>
          </Link>
          <Link href="/signup">
            <Button variant="secondary">Create account</Button>
          </Link>
          <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">
            Already have an account? Sign in
          </Link>
        </div>

        <dl className="mt-16 grid gap-8 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div key={feature.title}>
              <dt className="text-sm font-semibold text-foreground">{feature.title}</dt>
              <dd className="mt-1.5 text-sm text-muted-foreground">{feature.body}</dd>
            </div>
          ))}
        </dl>
      </div>
      <Footer />
    </div>
  );
}
