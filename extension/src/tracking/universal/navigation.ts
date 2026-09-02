import { extractFromUrl } from "./url";

/**
 * Looks for "previous"/"next" chapter-navigation links by their visible
 * text or rel/class hints, and checks whether the number their href
 * encodes is adjacent to the current page's number — strong corroborating
 * evidence (see confidence.ts), never a value source on its own. Only
 * link text/href/rel/class are read — no unrelated link content.
 */
export interface NavigationInfo {
  prevValue: number | null;
  nextValue: number | null;
}

const PREV_KEYWORDS = ["prev", "previous"];
const NEXT_KEYWORDS = ["next"];

function findLinkByKeyword(document: Document, keywords: string[]): HTMLAnchorElement | null {
  const links = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
  return (
    links.find((link) => {
      const haystack = `${link.textContent ?? ""} ${link.getAttribute("rel") ?? ""} ${link.className}`.toLowerCase();
      return keywords.some((keyword) => haystack.includes(keyword));
    }) ?? null
  );
}

function parseHrefValue(link: HTMLAnchorElement, baseUrl: URL): number | null {
  const href = link.getAttribute("href");
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    return extractFromUrl(url)?.value ?? null;
  } catch {
    return null;
  }
}

export function extractNavigation(document: Document, baseUrl: URL): NavigationInfo {
  const prevLink = findLinkByKeyword(document, PREV_KEYWORDS);
  const nextLink = findLinkByKeyword(document, NEXT_KEYWORDS);

  return {
    prevValue: prevLink ? parseHrefValue(prevLink, baseUrl) : null,
    nextValue: nextLink ? parseHrefValue(nextLink, baseUrl) : null,
  };
}
