/**
 * Reads a small, fixed set of standard page metadata — never arbitrary
 * page content. og:title and JSON-LD's `name` typically carry either the
 * work's title or (often) the title plus the current chapter, which is
 * exactly what's useful here; nothing else about a JSON-LD block is read.
 */
export interface PageMetadata {
  ogTitle: string | null;
  canonicalUrl: string | null;
  jsonLdName: string | null;
}

function readJsonLdName(document: Document): string | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of Array.from(scripts)) {
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? "");
      const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
      if (candidate && typeof candidate === "object" && "name" in candidate) {
        const name = (candidate as { name: unknown }).name;
        if (typeof name === "string" && name.trim().length > 0) return name.trim();
      }
    } catch {
      // Malformed JSON-LD on the page — not Markly's concern, just skip it.
    }
  }
  return null;
}

export function extractMetadata(document: Document): PageMetadata {
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() || null;
  const canonicalUrl = document.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() || null;
  const jsonLdName = readJsonLdName(document);

  return { ogTitle, canonicalUrl, jsonLdName };
}
