import { parseProgressText, type ProgressTextMatch } from "./progress";

/**
 * Checks only h1/h2 elements — likely to carry a chapter/episode heading
 * on a reader page — and only their own text, never the rest of the page.
 * Stops at the first heading that parses, so a page with many headings
 * doesn't get an ambiguous/late match.
 */
export function extractFromHeadings(document: Document): ProgressTextMatch | null {
  const headings = document.querySelectorAll("h1, h2");
  for (const heading of Array.from(headings)) {
    const match = parseProgressText(heading.textContent);
    if (match) return match;
  }
  return null;
}
