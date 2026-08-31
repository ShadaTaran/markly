/** Shared numeric-field parsing/validation for the media forms (full and compact/catalog). */

export interface ParsedNumber {
  value?: number;
  error?: string;
}

export function parseCount(raw: string, label: string, options: { positive?: boolean } = {}): ParsedNumber {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const n = Number(trimmed);
  const min = options.positive ? 1 : 0;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    return { error: `${label} must be a ${options.positive ? "positive" : "non-negative"} whole number.` };
  }
  return { value: n };
}

export function parseDecimal(raw: string, label: string): ParsedNumber {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    return { error: `${label} must be a non-negative number.` };
  }
  return { value: n };
}

export function parsePercent(raw: string): ParsedNumber {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { error: "Percent must be between 0 and 100." };
  }
  return { value: n };
}

export function parseRating(raw: string): ParsedNumber {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    return { error: "Rating must be between 1 and 10." };
  }
  return { value: Math.round(n * 2) / 2 };
}
