/**
 * Parses a short piece of text (a heading, document.title, an og:title
 * value) for a chapter/episode reference — "Chapter 234", "Ch. 234",
 * "Ch 234", "Episode 12", "Ep. 12", "Ep 12", and their decimal forms
 * ("Ch. 12.5") for manga split-release/extra chapters (see
 * MangaItem.currentChapter — decimals were already a supported concept
 * there; this is what lets a detection actually produce one). Word-
 * boundary-anchored so it doesn't fire on unrelated text that merely
 * contains "ch" or "ep" somewhere.
 *
 * Deliberately does NOT scan arbitrary body text — only ever called on
 * specific, bounded strings (a heading's own text, the title, one
 * metadata value), never a full page dump.
 */
export interface ProgressTextMatch {
  value: number;
  kind: "chapter" | "episode";
}

const CHAPTER_TEXT_PATTERN = /\bch(?:apter)?\.?\s*(\d+(?:\.\d+)?)\b/i;
const EPISODE_TEXT_PATTERN = /\bep(?:isode)?\.?\s*(\d+(?:\.\d+)?)\b/i;

export function parseProgressText(text: string | null | undefined): ProgressTextMatch | null {
  if (!text) return null;

  const chapterMatch = text.match(CHAPTER_TEXT_PATTERN);
  if (chapterMatch) {
    const value = Number(chapterMatch[1]);
    if (Number.isFinite(value)) return { value, kind: "chapter" };
  }

  const episodeMatch = text.match(EPISODE_TEXT_PATTERN);
  if (episodeMatch) {
    const value = Number(episodeMatch[1]);
    if (Number.isFinite(value)) return { value, kind: "episode" };
  }

  return null;
}
