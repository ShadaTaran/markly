/**
 * Stage 37 — pure delivery policy: retry classification, per-occurrence
 * outcome resolution, the catch-up window, and batching/concurrency
 * constants. No transport, no database, no React — see lib/push/deliver.ts
 * for the orchestration that actually calls these, and lib/push/transport.ts
 * for the one place that touches the `web-push` package.
 */

/** Stage 37 §40 — a bounded per-run batch, deterministic ordering (see due-reminders.ts): a large backlog drains predictably across runs rather than one unbounded invocation attempting all of it. */
export const MAX_DUE_REMINDERS_PER_RUN = 50;

/** Stage 37 §41 — a conservative fixed pool, never unbounded Promise.all against an external service. */
export const SEND_CONCURRENCY = 5;

/**
 * Stage 37 §36/§37 — the catch-up window. A reminder's in-app "due" status
 * (lib/reminders.ts) has no expiry by design and this constant must never
 * be imported there — it exists ONLY to stop a long-overdue reminder
 * (created before push existed, or missed across real downtime) from
 * suddenly generating a push the instant this feature ships or the
 * scheduler resumes. 24 hours: generous enough that an outage measured in
 * hours still delivers, short enough that a reminder from weeks/months ago
 * never surprises someone with a stale push. Affects ONLY whether a push
 * is attempted — the reminder itself, and its in-app Due listing, are
 * completely unaffected (Stage 37 §33/§58).
 */
export const CATCHUP_WINDOW_MINUTES = 1440;

/** Stage 37 §24/§27 — must match the literal cap encoded in claim_reminder_delivery()'s own logic (supabase/migrations/0017_stage37_web_push.sql); kept as a named constant here for documentation/tests, not because application code enforces it independently of the database. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Migration-review follow-up (§1/§3) — how long a claim is exclusively
 * owned before it becomes reclaimable by a later run, must match the
 * literal `make_interval(secs => 120)` in claim_reminder_delivery()
 * exactly (kept here for documentation/tests only — the database is the
 * real enforcement point, same convention as MAX_DELIVERY_ATTEMPTS above).
 *
 * Chosen relative to this stage's own architecture, not an arbitrary
 * round number: one occurrence's entire claim-to-finalize window is a
 * single reminder's fan-out to its own subscriptions at SEND_CONCURRENCY
 * (5) — realistically well under 10 seconds even for a user with several
 * devices, since each individual Web Push HTTP call typically resolves in
 * low seconds. 120s is generously larger than that (covering a slow
 * network/provider hiccup) while still being comfortably shorter than the
 * "every 1-5 minutes" scheduler cadence this stage's own architecture
 * assumes (Stage 37 §35) — a crash mid-send is therefore reclaimable on
 * the very next or second scheduler run, not stuck for a long tail.
 */
export const CLAIM_LEASE_SECONDS = 120;

/**
 * Migration-review follow-up (§5) — bounded exponential-ish backoff after
 * a retryable (or config_error) failure, indexed by the attempt number
 * that just failed (1-based). Prevents a 1-minute scheduler from burning
 * through all 5 attempts in 5 consecutive immediate runs: attempt 1's
 * failure waits 2 minutes before attempt 2 is even eligible, attempt 2's
 * waits 5 minutes, attempt 3's waits 15, attempt 4's waits 30 — attempt 5
 * either succeeds or the occurrence becomes permanently 'failed'
 * (exhausted). The exact minutes are a deliberately simple, conservative
 * choice (not a precisely tuned curve) — the goal is "meaningfully spaced
 * out," not an optimal retry schedule for any specific push provider.
 */
const RETRY_BACKOFF_MINUTES: readonly number[] = [2, 5, 15, 30];

/**
 * Final-review-pass fix (no-subscription churn, §3) — how long a
 * 'skipped' occurrence (zero active subscriptions at actual fan-out time)
 * waits before it becomes reclaimable again, must match the literal
 * comparison in claim_reminder_delivery()'s 'skipped' branch (kept here
 * for documentation/tests only). Deliberately NOT the same as
 * MAX_DELIVERY_ATTEMPTS/retryBackoffMinutes — a skip never consumes
 * attempt budget at all (see resolveDeliveryOutcome's own doc comment),
 * so this is a plain fixed defer, not a backoff curve.
 *
 * In practice this branch is now reached only for the narrow race where a
 * subscription existed when list_due_reminder_candidates ran but was gone
 * by the time this module actually resolved subscriptions a moment
 * later — the far more common "this user has never enabled push" case is
 * excluded from candidacy entirely by that function's own active-
 * subscription EXISTS check (0017_stage37_web_push.sql), so it never
 * reaches a claim at all. 15 minutes: frequent enough that a user who
 * enables push shortly after a reminder went off (while still within the
 * 24h catch-up window) still gets notified on a later scheduler run,
 * infrequent enough that a scheduler running every 1-5 minutes doesn't
 * repeatedly re-examine the same dead-end occurrence.
 */
export const SKIPPED_RETRY_DEFER_MINUTES = 15;

export function retryBackoffMinutes(attemptCount: number): number {
  const index = Math.min(Math.max(attemptCount, 1) - 1, RETRY_BACKOFF_MINUTES.length - 1);
  return RETRY_BACKOFF_MINUTES[index];
}

/** True when `dueAtMs` falls within the catch-up window ending at `nowMs` — i.e. overdue but not SO overdue it should be silently skipped for push purposes. A reminder due in the future is never "due" at all (isDue is the caller's job to have already established); this only bounds how far into the past a push will still be attempted. */
export function isWithinCatchUpWindow(dueAtMs: number, nowMs: number, catchupWindowMinutes: number = CATCHUP_WINDOW_MINUTES): boolean {
  return dueAtMs <= nowMs && nowMs - dueAtMs <= catchupWindowMinutes * 60_000;
}

/** Stage 37 §29/§70 — classifies one Web Push HTTP response. `null` means a network-level failure (no response at all), treated the same as a retryable server error. */
export type PushFailureClass = "permanent" | "retryable" | "config_error";

export function classifyPushFailure(statusCode: number | null): PushFailureClass {
  if (statusCode === 404 || statusCode === 410) return "permanent";
  if (statusCode === 401 || statusCode === 403) return "config_error";
  return "retryable";
}

/** One subscription's outcome for one send attempt. */
export type SubscriptionSendOutcome =
  | { subscriptionId: string; outcome: "sent" }
  | { subscriptionId: string; outcome: "permanent_failure"; statusCode: number }
  | { subscriptionId: string; outcome: "config_error"; statusCode: number }
  | { subscriptionId: string; outcome: "retryable_failure"; statusCode: number | null };

export interface DeliveryOutcome {
  status: "sent" | "failed" | "skipped";
  retryable: boolean;
}

/**
 * Stage 37 §31/§36 — success is defined at the OCCURRENCE level: at least
 * one subscription receiving it is success, full stop, regardless of how
 * many others failed. Zero subscriptions is "skipped," never "failed" —
 * there is nothing wrong with the reminder, it simply has no destination
 * yet (Stage 37 §32). `retryable` is true only when trying again could
 * plausibly reach a DIFFERENT outcome — i.e. at least one failure this
 * round was itself retryable/config_error; if every failure was
 * "permanent," those subscriptions are already disabled and retrying
 * would just reproduce "skipped" with one fewer subscription, so there is
 * nothing to gain (documented limitation: a brand new subscription added
 * after this point would not retroactively receive this specific already-
 * resolved occurrence — see the Stage 37 report's operational limitations).
 */
export function resolveDeliveryOutcome(results: readonly SubscriptionSendOutcome[]): DeliveryOutcome {
  if (results.length === 0) return { status: "skipped", retryable: false };
  if (results.some((result) => result.outcome === "sent")) return { status: "sent", retryable: false };
  const canRetry = results.some((result) => result.outcome === "retryable_failure" || result.outcome === "config_error");
  return { status: "failed", retryable: canRetry };
}

/** Whether classify()'s result should ever disable the subscription row — true for exactly one class (Stage 37 §29/§30): a dead endpoint. Config/auth errors and transient failures must never touch the subscription. */
export function shouldDisableSubscription(failureClass: PushFailureClass): boolean {
  return failureClass === "permanent";
}

/**
 * Bounded-concurrency map (Stage 37 §41) — never Promise.all against an
 * external service. Preserves input order in the returned array
 * regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
