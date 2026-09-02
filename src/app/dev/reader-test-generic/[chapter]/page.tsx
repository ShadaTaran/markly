import type { Metadata } from "next";

/**
 * Second controlled test page, deliberately using ORDINARY reader-style
 * markup with none of /dev/reader-test's data-markly-reader-* attributes
 * — proves the extension's universal detection engine (extension/src/
 * tracking/universal/) is not secretly dependent on Markly-specific
 * selectors. It relies only on generic signals a real reading site would
 * plausibly already have: a /chapter-N URL, an h1 mentioning the
 * chapter, a matching document title, an og:title meta tag, and
 * Previous/Next Chapter links.
 *
 * Development/testing only, not a real feature.
 */

const TITLE = "The Wandering Inn";
const MAX_CHAPTER = 300;

interface GenericReaderPageProps {
  params: Promise<{ chapter: string }>;
}

function parseChapterSegment(segment: string): number {
  const match = segment.match(/^chapter-(\d+)$/);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), MAX_CHAPTER) : 1;
}

export async function generateMetadata({ params }: GenericReaderPageProps): Promise<Metadata> {
  const { chapter } = await params;
  const chapterNumber = parseChapterSegment(chapter);
  const title = `${TITLE} - Chapter ${chapterNumber}`;
  return {
    title,
    openGraph: { title },
  };
}

export default async function GenericReaderTestPage({ params }: GenericReaderPageProps) {
  const { chapter } = await params;
  const chapterNumber = parseChapterSegment(chapter);
  const prevChapter = chapterNumber > 1 ? chapterNumber - 1 : null;
  const nextChapter = chapterNumber < MAX_CHAPTER ? chapterNumber + 1 : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="mb-4 text-xs text-muted-foreground">
        Markly Generic Test Reader — development only. Ordinary reader markup, no Markly-specific
        attributes; proves universal (adapter-free) detection.
      </p>

      <main>
        <h1 className="text-xl font-semibold text-foreground">
          {TITLE} — Chapter {chapterNumber}
        </h1>

        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          This is placeholder chapter text for exercising Markly&apos;s universal detection engine.
          Navigating to another chapter loads a fresh page, same as the other test reader.
        </p>

        <div className="mt-8 flex items-center justify-between">
          {prevChapter ? (
            <a
              href={`/dev/reader-test-generic/chapter-${prevChapter}`}
              className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              Previous Chapter
            </a>
          ) : (
            <span />
          )}
          {nextChapter && (
            <a
              href={`/dev/reader-test-generic/chapter-${nextChapter}`}
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
