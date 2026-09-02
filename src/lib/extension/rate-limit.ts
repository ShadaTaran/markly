import "server-only";

/**
 * In-memory, per-process, fixed-window rate limiter for the pairing
 * endpoint. Deliberately not a distributed solution (Redis, etc.) — the
 * user asked for defense-in-depth without pulling in an external
 * dependency for this alone, and it doesn't need to be perfect: the
 * pairing code's own entropy (60 bits, see tokens.ts) is what actually
 * makes brute-forcing infeasible within the 10-minute TTL. This limiter
 * just adds a cheap second layer, and resets on server restart / is
 * per-instance under multiple processes — both acceptable for that role.
 */
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 10;

const attempts = new Map<string, { count: number; windowStart: number }>();

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_ATTEMPTS_PER_WINDOW;
}
