/**
 * Defensive normalization for raw external API data. Nothing from a
 * provider is trusted as-is: missing/null fields, malformed dates, and
 * (especially) provider-supplied HTML must never reach the UI unprocessed.
 */

/** Strips HTML tags and decodes a handful of common entities. Never rendered via dangerouslySetInnerHTML. */
export function stripHtml(input: string): string {
  const withoutTags = input.replace(/<[^>]*>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
  return decoded.replace(/\s+/g, " ").trim();
}

export function normalizeDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripHtml(value);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Accepts a 4-digit year, a full date string, or a number; rejects anything implausible. */
export function normalizeYear(value: unknown): number | undefined {
  const n =
    typeof value === "string"
      ? Number(value.slice(0, 4))
      : typeof value === "number"
        ? value
        : Number.NaN;
  return Number.isFinite(n) && n >= 1000 && n <= 3000 ? n : undefined;
}

export function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

export function normalizePositiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
}
