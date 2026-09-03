import "server-only";

/**
 * Logs only a fixed whitelist of non-secret fields from a caught error to
 * the server terminal — a Postgrest/Postgres error's `code`/`message`/
 * `details`/`hint` (exactly what a Supabase `{ error }` result carries), or
 * a plain Error's message. Never logs the raw error object, request
 * headers, or anything else that could carry a bearer token, cookie, or
 * secret key — see route.ts/auto-add.ts's own callers for what those would
 * otherwise risk. The HTTP response to the extension stays the existing
 * sanitized `{ error: "tracking_failed" }` regardless; this is
 * terminal-only, for local debugging.
 */
export function logSanitizedError(label: string, error: unknown): void {
  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    console.error(label, {
      code: typeof candidate.code === "string" ? candidate.code : undefined,
      message: typeof candidate.message === "string" ? candidate.message : undefined,
      details: typeof candidate.details === "string" ? candidate.details : undefined,
      hint: typeof candidate.hint === "string" ? candidate.hint : undefined,
    });
    return;
  }
  console.error(label, { message: String(error) });
}
