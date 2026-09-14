import Link from "next/link";

/**
 * Stage 45 — a restrained footer for the public-facing surfaces only
 * (landing, privacy, terms, support). Deliberately not added to the
 * authenticated app shell (Dashboard/Library/Settings/...) — those already
 * have their own Header-driven layout, and a second persistent nav element
 * there would just be clutter for someone already signed in.
 */
export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted-foreground sm:px-6">
        <span>Markly — Beta</span>
        <nav aria-label="Legal and support" className="flex flex-wrap gap-x-4 gap-y-2">
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>
          <Link href="/support" className="hover:text-foreground">
            Support
          </Link>
          <a
            href="https://github.com/ShadaTaran/markly"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
