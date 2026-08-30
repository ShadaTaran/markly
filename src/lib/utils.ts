export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function getFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed);
  return hasProtocol ? trimmed : `https://${trimmed}`;
}

export function isValidUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    if (protocol !== "http:" && protocol !== "https:") return false;
    return hostname.length > 0 && (hostname.includes(".") || hostname === "localhost");
  } catch {
    return false;
  }
}

export function parseTags(raw: string): string[] {
  const tags = new Set<string>();
  for (const part of raw.split(",")) {
    const tag = part.trim().toLowerCase();
    if (tag) tags.add(tag);
  }
  return Array.from(tags);
}

export function generateBookmarkId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
