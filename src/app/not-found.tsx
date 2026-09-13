import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/Button";

/**
 * Stage 44 — a coherent 404 for both an unknown route and (via each
 * page's own notFound()/redirect-on-missing-resource handling) a known
 * route naming a resource that doesn't exist or isn't this user's. Never
 * exposes which case it was, or any database/route detail — a real
 * stranger gets the same simple message either way.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center px-4 py-10 text-center">
      <div className="mb-6 flex items-center justify-center gap-2">
        <Logo />
        <span className="text-lg font-semibold tracking-tight">Markly</span>
      </div>
      <h1 className="mb-1 text-lg font-semibold text-foreground">Page not found</h1>
      <p className="mb-6 text-sm text-muted-foreground">This page doesn&rsquo;t exist, or you don&rsquo;t have access to it.</p>
      <Link href="/library">
        <Button variant="primary">Back to Library</Button>
      </Link>
    </div>
  );
}
