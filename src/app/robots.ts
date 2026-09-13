import type { MetadataRoute } from "next";

/**
 * Stage 44 — Markly has no public marketing content to index, and during a
 * small beta there is no benefit to search engines crawling it (and a
 * clear downside if a stray public/anonymous view ever got indexed and
 * surfaced to a stranger via search before the product is ready for that).
 * Revisit this if/when Markly ever wants public discoverability.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
