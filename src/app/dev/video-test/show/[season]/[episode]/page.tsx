import type { Metadata } from "next";
import { VideoTestHarness } from "../../../[episode]/VideoTestHarness";

/**
 * Deterministic development harness for Stage 25's season-aware progress
 * model — the seasonal counterpart to ../../[episode]/page.tsx (Stage 24's
 * absolute-numbering harness). Reuses the exact same generated-video
 * component (no bundled/fetched video asset here either); the only
 * difference is the URL shape and the matching dev-only adapter that reads
 * it (extension/src/adapters/markly-season-test.ts), which emits a
 * {kind:"season_episode", season, episode} detection instead of the
 * universal detector's {kind:"episode", value}. Proves the season+episode
 * wire shape and the atomic seasonal comparison RPC end-to-end without a
 * real streaming provider — Stage 25 deliberately doesn't add one (see
 * README "Season-Aware Episode Tracking").
 *
 * Development/testing only, not a real feature.
 */

const TITLE = "Markly Test Anime (Seasonal)";
const MAX_SEASON = 5;
const MAX_EPISODE = 24;

interface SeasonVideoTestPageProps {
  params: Promise<{ season: string; episode: string }>;
}

function parseSegment(segment: string, prefix: "season" | "episode", max: number): number {
  const match = segment.match(new RegExp(`^${prefix}-(\\d+)$`));
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), max) : 1;
}

export async function generateMetadata({ params }: SeasonVideoTestPageProps): Promise<Metadata> {
  const { season, episode } = await params;
  const seasonNumber = parseSegment(season, "season", MAX_SEASON);
  const episodeNumber = parseSegment(episode, "episode", MAX_EPISODE);
  const title = `${TITLE} - Season ${seasonNumber} - Episode ${episodeNumber}`;
  return { title, openGraph: { title } };
}

export default async function SeasonVideoTestPage({ params }: SeasonVideoTestPageProps) {
  const { season, episode } = await params;
  const seasonNumber = parseSegment(season, "season", MAX_SEASON);
  const episodeNumber = parseSegment(episode, "episode", MAX_EPISODE);

  const prevEpisode = episodeNumber > 1 ? episodeNumber - 1 : null;
  const nextEpisode = episodeNumber < MAX_EPISODE ? episodeNumber + 1 : null;
  // "Next season" only ever appears from the last modeled episode of a
  // season, and always resets to episode 1 — this is the one navigation
  // link deliberately shaped to prove the exact "S1E{last} -> S2E1" case
  // Stage 25 exists to get right (see README's acceptance-test scenario).
  const nextSeasonFromLastEpisode = episodeNumber === MAX_EPISODE && seasonNumber < MAX_SEASON ? seasonNumber + 1 : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="mb-4 text-xs text-muted-foreground">
        Markly Season Test Harness — development only. Read by a dedicated dev-only adapter
        (markly-season-test.ts), not universal detection — Stage 25 doesn&apos;t add generic
        season parsing for arbitrary sites. Emits {"{kind: \"season_episode\", season, episode}"}.
      </p>

      <main>
        <h1 className="text-xl font-semibold text-foreground">
          {TITLE} — Season {seasonNumber}, Episode {episodeNumber}
        </h1>

        <VideoTestHarness episodeNumber={episodeNumber} />

        <div className="mt-8 flex items-center justify-between">
          {prevEpisode ? (
            <a
              href={`/dev/video-test/show/season-${seasonNumber}/episode-${prevEpisode}`}
              className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              Previous Episode
            </a>
          ) : (
            <span />
          )}
          {nextEpisode && (
            <a
              href={`/dev/video-test/show/season-${seasonNumber}/episode-${nextEpisode}`}
              className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
            >
              Next Episode
            </a>
          )}
          {nextSeasonFromLastEpisode && (
            <a
              href={`/dev/video-test/show/season-${nextSeasonFromLastEpisode}/episode-1`}
              className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-background transition-colors hover:opacity-90"
            >
              Next Season →
            </a>
          )}
        </div>
      </main>
    </div>
  );
}
