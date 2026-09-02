/**
 * Development-only controlled reading page — proves the Stage 18
 * auto-tracking pipeline (content script → adapter → service worker →
 * Markly API) without depending on a real external site's DOM, which can
 * change at any time. Not a real feature; Stage 19 adds real adapters
 * for actual reading sites.
 *
 * Uses ordinary full-page navigation per chapter (a plain <a href>, no
 * client-side routing) so the extension's tab-load-based detection stays
 * simple — matching how many real reader sites load a fresh page per
 * chapter. The data-markly-reader attributes give the test adapter a
 * stable, unambiguous structure to read, standing in for whatever
 * (messier) selectors a real site adapter will need in Stage 19.
 */

const TITLE = "Lord of Mysteries";
const SOURCE_KEY = "lord-of-mysteries";
const MAX_CHAPTER = 300;

interface ReaderTestPageProps {
  searchParams: Promise<{ chapter?: string }>;
}

export default async function ReaderTestPage({ searchParams }: ReaderTestPageProps) {
  const params = await searchParams;
  const parsed = Number(params.chapter);
  const chapter = Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), MAX_CHAPTER) : 1;

  const prevChapter = chapter > 1 ? chapter - 1 : null;
  const nextChapter = chapter < MAX_CHAPTER ? chapter + 1 : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="mb-4 text-xs text-muted-foreground">Markly Test Reader — development only, not a real feature.</p>

      <main data-markly-reader="root" data-source-key={SOURCE_KEY} data-source-title={TITLE}>
        <h1 data-markly-reader="title" className="text-xl font-semibold text-foreground">
          {TITLE}
        </h1>
        <p data-markly-reader="chapter" data-chapter-number={chapter} className="mt-2 text-lg text-foreground">
          Chapter {chapter}
        </p>

        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          This is placeholder chapter text for exercising the Markly auto-tracking pipeline. Navigating to another
          chapter loads a fresh page — a real reading site would too.
        </p>

        <div className="mt-8 flex items-center justify-between">
          {prevChapter ? (
            <a
              href={`/dev/reader-test?chapter=${prevChapter}`}
              className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              Previous Chapter
            </a>
          ) : (
            <span />
          )}
          {nextChapter && (
            <a
              href={`/dev/reader-test?chapter=${nextChapter}`}
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
