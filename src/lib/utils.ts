export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function parseTags(raw: string): string[] {
  const tags = new Set<string>();
  for (const part of raw.split(",")) {
    const tag = part.trim().toLowerCase();
    if (tag) tags.add(tag);
  }
  return Array.from(tags);
}

/** Like parseTags, but preserves case — for names (e.g. book authors), not tags. */
export function parseCommaList(raw: string): string[] {
  const items: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed) items.push(trimmed);
  }
  return items;
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
