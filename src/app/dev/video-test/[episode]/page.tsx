import type { Metadata } from "next";
import { VideoTestHarness } from "./VideoTestHarness";

/**
 * Deterministic development harness for Stage 24's generic video-
 * completion observer (extension/src/tracking/video/completion.ts).
 * Ordinary universal-detectable markup (a real <h1>, a matching
 * document/og title, an /episode-N URL) — no Markly-specific adapter
 * attributes, so this exercises the exact same detection path a real
 * anime site would. The video itself is generated entirely client-side
 * from a <canvas> (see VideoTestHarness) — no video asset is bundled or
 * fetched, so there is no copyrighted footage of any kind here, generated
 * or otherwise.
 *
 * Development/testing only, not a real feature.
 */

const TITLE = "Markly Test Anime";
const MAX_EPISODE = 24;

interface VideoTestPageProps {
  params: Promise<{ episode: string }>;
}

function parseEpisodeSegment(segment: string): number {
  const match = segment.match(/^episode-(\d+)$/);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), MAX_EPISODE) : 1;
}

export async function generateMetadata({ params }: VideoTestPageProps): Promise<Metadata> {
  const { episode } = await params;
  const episodeNumber = parseEpisodeSegment(episode);
  const title = `${TITLE} - Episode ${episodeNumber}`;
  return { title, openGraph: { title } };
}

export default async function VideoTestPage({ params }: VideoTestPageProps) {
  const { episode } = await params;
  const episodeNumber = parseEpisodeSegment(episode);
  const prevEpisode = episodeNumber > 1 ? episodeNumber - 1 : null;
  const nextEpisode = episodeNumber < MAX_EPISODE ? episodeNumber + 1 : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="mb-4 text-xs text-muted-foreground">
        Markly Video Test Harness — development only. Generic reader-style markup (real heading,
        matching document/og title, /episode-N URL) plus a real, locally-generated HTML5{" "}
        <code>&lt;video&gt;</code> — no bundled video asset, no copyrighted content of any kind. Exercises
        the extension&apos;s generic completion observer, not any site-specific code.
      </p>

      <main>
        <h1 className="text-xl font-semibold text-foreground">
          {TITLE} — Episode {episodeNumber}
        </h1>

        <VideoTestHarness episodeNumber={episodeNumber} />

        <div className="mt-8 flex items-center justify-between">
          {prevEpisode ? (
            <a
              href={`/dev/video-test/episode-${prevEpisode}`}
              className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              Previous Episode
            </a>
          ) : (
            <span />
          )}
          {nextEpisode && (
            <a
              href={`/dev/video-test/episode-${nextEpisode}`}
              className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
            >
              Next Episode
            </a>
          )}
        </div>
      </main>
    </div>
  );
}
