/**
 * Reads a small, fixed set of standard page metadata — never arbitrary
 * page content. og:title and JSON-LD's `name` typically carry either the
 * work's title or (often) the title plus the current chapter; og:image,
 * a work-shaped JSON-LD block's `image`/`author`/`description`/`genre`,
 * and og:description/meta description round out what Stage 21's
 * enrichment can safely use — nothing else about a JSON-LD block or the
 * page is ever read, and none of it is the chapter's own text.
 */
export interface PageMetadata {
  ogTitle: string | null;
  canonicalUrl: string | null;
  jsonLdName: string | null;
  ogImage: string | null;
  description: string | null;
  authors: string[];
  genres: string[];
}

// schema.org types that describe the SITE, not the work being read — a
// page can legitimately carry one of these alongside (or instead of) a
// work-describing block (e.g. an Organization block naming the site
// itself), and its `name` must never be mistaken for a work title.
// Observed on a real site (NovelPhoenix carries an Organization block
// naming itself "Novel Phoenix" on every page) — see extension/README.md.
const NON_WORK_JSON_LD_TYPES = new Set(["Organization", "WebSite", "BreadcrumbList", "WebPage", "SiteNavigationElement"]);

interface JsonLdBlock {
  "@type"?: unknown;
  name?: unknown;
  image?: unknown;
  author?: unknown;
  description?: unknown;
  genre?: unknown;
}

/** Every JSON-LD block on the page whose @type isn't one of the site-identity types above — i.e. candidates that might actually describe the work. */
function readWorkJsonLdBlocks(document: Document): JsonLdBlock[] {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  const blocks: JsonLdBlock[] = [];
  for (const script of Array.from(scripts)) {
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? "");
      const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!candidate || typeof candidate !== "object") continue;
      const type = (candidate as JsonLdBlock)["@type"];
      if (typeof type === "string" && NON_WORK_JSON_LD_TYPES.has(type)) continue;
      blocks.push(candidate as JsonLdBlock);
    } catch {
      // Malformed JSON-LD on the page — not Markly's concern, just skip it.
    }
  }
  return blocks;
}

function readJsonLdName(blocks: JsonLdBlock[]): string | null {
  for (const block of blocks) {
    if (typeof block.name === "string" && block.name.trim().length > 0) return block.name.trim();
  }
  return null;
}

/** schema.org `author` is a Person/Organization (single or array) or, less often, a bare string — never free text to parse. */
function readJsonLdAuthors(blocks: JsonLdBlock[]): string[] {
  for (const block of blocks) {
    if (block.author === undefined) continue;
    const candidates = Array.isArray(block.author) ? block.author : [block.author];
    const names = candidates
      .map((candidate) => {
        if (typeof candidate === "string") return candidate.trim();
        if (candidate && typeof candidate === "object" && "name" in candidate) {
          const name = (candidate as { name: unknown }).name;
          return typeof name === "string" ? name.trim() : "";
        }
        return "";
      })
      .filter((name) => name.length > 0);
    if (names.length > 0) return names;
  }
  return [];
}

/** schema.org `genre` is a string or an array of strings. */
function readJsonLdGenres(blocks: JsonLdBlock[]): string[] {
  for (const block of blocks) {
    if (block.genre === undefined) continue;
    const candidates = Array.isArray(block.genre) ? block.genre : [block.genre];
    const genres = candidates.filter((g): g is string => typeof g === "string" && g.trim().length > 0).map((g) => g.trim());
    if (genres.length > 0) return genres;
  }
  return [];
}

function readJsonLdImage(blocks: JsonLdBlock[]): string | null {
  for (const block of blocks) {
    if (typeof block.image === "string" && block.image.trim().length > 0) return block.image.trim();
    if (block.image && typeof block.image === "object" && "url" in block.image) {
      const url = (block.image as { url: unknown }).url;
      if (typeof url === "string" && url.trim().length > 0) return url.trim();
    }
  }
  return null;
}

function readJsonLdDescription(blocks: JsonLdBlock[]): string | null {
  for (const block of blocks) {
    if (typeof block.description === "string" && block.description.trim().length > 0) return block.description.trim();
  }
  return null;
}

/** The reading site's own identity (its name, not the work's) — used only to recognize and discard metadata that's actually about the site, e.g. a `<meta name="author">` tag some sites fill with their own site name instead of leaving it out. Never itself sent anywhere. */
export function readSiteIdentity(document: Document): string | null {
  const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim();
  if (ogSiteName) return ogSiteName;
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? "");
      const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
      if (
        candidate &&
        typeof candidate === "object" &&
        (candidate as JsonLdBlock)["@type"] === "Organization" &&
        typeof (candidate as JsonLdBlock).name === "string"
      ) {
        return ((candidate as JsonLdBlock).name as string).trim();
      }
    } catch {
      // Skip malformed JSON-LD.
    }
  }
  return null;
}

/** A page's own `<meta name="author">` tag, read separately from JSON-LD authors since it needs the site-identity filter applied by the caller (metadata.ts stays a pure reader; detected-metadata.ts decides what's trustworthy). */
export function readMetaAuthor(document: Document): string | null {
  return document.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() || null;
}

export function extractMetadata(document: Document): PageMetadata {
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() || null;
  const canonicalUrl = document.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() || null;
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content")?.trim() || null;
  const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() || null;
  const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || null;

  const workBlocks = readWorkJsonLdBlocks(document);
  const jsonLdName = readJsonLdName(workBlocks);

  return {
    ogTitle,
    canonicalUrl,
    jsonLdName,
    ogImage: ogImage ?? readJsonLdImage(workBlocks),
    description: ogDescription ?? metaDescription ?? readJsonLdDescription(workBlocks),
    authors: readJsonLdAuthors(workBlocks),
    genres: readJsonLdGenres(workBlocks),
  };
}
