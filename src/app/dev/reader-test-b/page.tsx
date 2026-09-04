/**
 * Development-only controlled reading page — Stage 26's second, distinct
 * source for the SAME real work NovelPhoenix tracks
 * (https://novelphoenix.com/novel/lord-of-the-mysteries — "Lord of the
 * Mysteries," WITH "the"), proving the cross-source model (two
 * tracking_sources rows, one LibraryItem, one unified progress) without a
 * second real site. Deliberately does NOT reuse /dev/reader-test's own
 * long-standing "Lord of Mysteries" (no "the") fixture title — that page
 * predates Stage 26 and is a separate, unrelated smoke test; matching it
 * here by coincidence would have been exactly the kind of near-miss title
 * Smart Auto-Link's exact normalized matching is supposed to tell apart,
 * not a real "two sources, one work" scenario. Read by a separate dev-only
 * adapter (markly-test-reader-b.ts, a different adapterId — so a
 * genuinely distinct tracking_sources identity, never pretending to be
 * NovelPhoenix's own hostname/URL) reusing the exact same
 * data-markly-reader-* attribute convention as the original. Not a real
 * feature.
 */

const TITLE = "Lord of the Mysteries";
const SOURCE_KEY = "lord-of-the-mysteries";
const MAX_CHAPTER = 300;

interface ReaderTestBPageProps {
  searchParams: Promise<{ chapter?: string }>;
}

export default async function ReaderTestBPage({ searchParams }: ReaderTestBPageProps) {
  const params = await searchParams;
  const parsed = Number(params.chapter);
  const chapter = Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), MAX_CHAPTER) : 1;

  const prevChapter = chapter > 1 ? chapter - 1 : null;
  const nextChapter = chapter < MAX_CHAPTER ? chapter + 1 : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="mb-4 text-xs text-muted-foreground">
        Markly Test Reader B — development only, not a real feature. Reports the same work title as the
        real NovelPhoenix source (&quot;Lord of the Mysteries&quot;), from a distinct source identity, to
        prove cross-source tracking.
      </p>

      <main data-markly-reader="root" data-source-key={SOURCE_KEY} data-source-title={TITLE}>
        <h1 data-markly-reader="title" className="text-xl font-semibold text-foreground">
          {TITLE}
        </h1>
        <p data-markly-reader="chapter" data-chapter-number={chapter} className="mt-2 text-lg text-foreground">
          Chapter {chapter}
        </p>

        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          This is placeholder chapter text for exercising Markly&apos;s cross-source tracking pipeline. Navigating to
          another chapter loads a fresh page, same as the primary test reader.
        </p>

        <div className="mt-8 flex items-center justify-between">
          {prevChapter ? (
            <a
              href={`/dev/reader-test-b?chapter=${prevChapter}`}
              className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              Previous Chapter
            </a>
          ) : (
            <span />
          )}
          {nextChapter && (
            <a
              href={`/dev/reader-test-b?chapter=${nextChapter}`}
              className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
            >
              Next Chapter
            </a>
          )}
        </div>
      </main>
    </div>
  );
}
