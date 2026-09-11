import { isValidUrl, normalizeUrl } from "@/lib/website";

/**
 * Stage 39 — pure, deterministic extraction of ONE candidate URL from a Web
 * Share Target payload (`url`/`title`/`text`, all untrusted input). Never
 * treats arbitrary text as a URL wholesale, never returns more than one
 * candidate, and never fetches anything — this module only decides "is
 * there a URL-shaped, safe-scheme, credential-free string here," reusing
 * lib/website.ts's existing isValidUrl/normalizeUrl (the same validation
 * the manual Website Add form already relies on) rather than inventing a
 * second policy.
 */

// A share payload is attacker/publisher-controlled input from any page's
// own share button — these are defensive ceilings, not real-world share
// sizes, chosen so a pathological query string can't push megabytes of
// text into component state or a regex scan (Stage 39 §37).
export const MAX_SHARE_URL_LENGTH = 2000;
export const MAX_SHARE_TEXT_LENGTH = 4000;
export const MAX_SHARE_TITLE_LENGTH = 300;

export interface ShareCapturePayload {
  url?: string | null;
  title?: string | null;
  text?: string | null;
}

/**
 * Stage 39 correction — a bare `string | null` conflated "no link was
 * shared" with "a link was shared but is unsafe/malformed," which produced
 * an inaccurate UI ("No link was included" for a rejected credential URL).
 * A discriminated result keeps those genuinely different situations
 * genuinely distinct for both the UI and the tests.
 */
export type ShareUrlResult =
  | { status: "valid"; url: string }
  | { status: "missing" }
  | { status: "invalid"; reason: "too-long" | "unsafe" | "malformed" };

function clamp(value: string | null | undefined, maxLength: number): string {
  if (!value) return "";
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** Trims trailing punctuation prose commonly leaves stuck to a URL ("...see https://example.com/foo." or "(https://example.com/foo)"). Never trims characters that are a legitimate part of a URL's own structure otherwise (query/fragment/path chars are untouched). */
function trimTrailingProsePunctuation(candidate: string): string {
  return candidate.replace(/[.,;:!?)\]}'"]+$/, "");
}

const URL_SCAN_PATTERN = /https?:\/\/[^\s<>"']+/i;

/**
 * Classifies ONE already-isolated candidate string. Length is checked
 * against the RAW, untrimmed value before anything else — silently
 * truncating an over-limit URL and then judging the truncated remainder
 * would risk calling a mangled, different URL "valid" (Stage 39 correction
 * §1, test matrix item J).
 */
function classifyUrlCandidate(raw: string): ShareUrlResult {
  if (raw.length > MAX_SHARE_URL_LENGTH) return { status: "invalid", reason: "too-long" };

  const normalized = normalizeUrl(raw);
  if (isValidUrl(normalized)) return { status: "valid", url: normalized };

  // isValidUrl's single boolean already covers three distinct failure
  // causes (unparseable, wrong scheme, credentials present) — reproduce
  // just enough of its own checks here to label which one, for tests and
  // internal clarity only. The UI itself deliberately shows one generic
  // "this link can't be used" message regardless (Stage 39 correction §3
  // — no technical distinction is surfaced to the user).
  try {
    new URL(normalized);
    return { status: "invalid", reason: "unsafe" };
  } catch {
    return { status: "invalid", reason: "malformed" };
  }
}

/**
 * Priority, per Stage 39 §5/§1(correction): an explicit `url` field is
 * authoritative — if present, its outcome (valid or invalid) is final and
 * `text` is never consulted, so an unsafe/malformed explicit URL is never
 * silently masked by a different link that happens to sit in `text` (test
 * matrix item L). Only when `url` is genuinely absent does the first
 * URL-shaped substring in `text` get a try; a bad candidate found only
 * there (never explicitly supplied as *the* link) degrades to "missing"
 * rather than "invalid" — prose scanning is opportunistic, not
 * authoritative, so it doesn't earn the stronger rejection message. A
 * title is never scanned for a URL at all — it's treated as a hint
 * elsewhere, never a link source (test matrix item N).
 */
export function extractShareUrl(payload: ShareCapturePayload): ShareUrlResult {
  const rawUrl = (payload.url ?? "").trim();
  if (rawUrl) return classifyUrlCandidate(rawUrl);

  const rawText = clamp(payload.text, MAX_SHARE_TEXT_LENGTH);
  const match = URL_SCAN_PATTERN.exec(rawText);
  if (match) {
    const candidate = trimTrailingProsePunctuation(match[0]);
    const result = classifyUrlCandidate(candidate);
    if (result.status === "valid") return result;
  }

  return { status: "missing" };
}

/** A title is a hint, never authoritative catalog metadata (Stage 39 §19) — just length-bounded and trimmed. */
export function extractShareTitle(payload: ShareCapturePayload): string {
  return clamp(payload.title, MAX_SHARE_TITLE_LENGTH).trim();
}

export function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
