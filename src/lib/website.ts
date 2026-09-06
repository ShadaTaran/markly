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

/**
 * Rejects userinfo (`https://user:pass@host/...`) alongside the existing
 * scheme check — a credential-bearing URL is never something Markly needs
 * to store or navigate to for a personal bookmark/resume link, and letting
 * one through would render a deceptive or sensitive href verbatim (Stage
 * 32 correctness review).
 */
export function isValidUrl(value: string): boolean {
  try {
    const { protocol, hostname, username, password } = new URL(value);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (username || password) return false;
    return hostname.length > 0 && (hostname.includes(".") || hostname === "localhost");
  } catch {
    return false;
  }
}
