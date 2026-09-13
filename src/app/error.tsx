"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/Button";

/**
 * Stage 44 — the App Router error boundary for every route under this
 * layout. Next.js renders this in place of the failed segment whenever a
 * Server or Client Component throws during render; without it, production
 * users previously saw Next's own generic, unstyled fallback. Never shows
 * `error.message`/`error.stack` — those are exactly the kind of internal
 * detail (which query failed, which field was undefined) a real stranger
 * has no use for and shouldn't see. Logged to the console only, matching
 * every other error path in this app (see lib/extension/log-error.ts's own
 * sanitized-logging convention) — never sent anywhere, never included in
 * the rendered UI.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app] unhandled render error");
  }, []);

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center px-4 py-10 text-center">
      <div className="mb-6 flex items-center justify-center gap-2">
        <Logo />
        <span className="text-lg font-semibold tracking-tight">Markly</span>
      </div>
      <h1 className="mb-1 text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        An unexpected error occurred. Your data is safe — you can try again or head back to your library.
      </p>
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link href="/library">
          <Button variant="secondary">Back to Library</Button>
        </Link>
      </div>
    </div>
  );
}
