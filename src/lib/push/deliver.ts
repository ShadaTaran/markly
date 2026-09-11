import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PushSubscriptionRow } from "@/lib/supabase/database.types";
import { sendWebPush, isPushConfigured, type PushSubscriptionKeys } from "@/lib/push/transport";
import { buildReminderNotificationPayload, type NotificationPayload } from "@/lib/push/payload";
import {
  MAX_DUE_REMINDERS_PER_RUN,
  CATCHUP_WINDOW_MINUTES,
  SEND_CONCURRENCY,
  classifyPushFailure,
  resolveDeliveryOutcome,
  shouldDisableSubscription,
  mapWithConcurrency,
  retryBackoffMinutes,
  SKIPPED_RETRY_DEFER_MINUTES,
  type SubscriptionSendOutcome,
} from "@/lib/push/delivery-policy";

/**
 * Stage 37 — the due-reminder delivery engine (§23). Orchestration only:
 * the actual "what's due" computation lives in the database
 * (list_due_reminder_candidates, supabase/migrations/0017_stage37_web_push.sql),
 * the atomic claim lives in claim_reminder_delivery (same migration), and
 * the retry/outcome policy lives in lib/push/delivery-policy.ts — this
 * module just wires them together and performs the one thing that
 * genuinely cannot happen inside a database transaction: the external Web
 * Push network call (Stage 37 §28).
 *
 * Called only from the cron-protected /api/push/process-due route, with a
 * service-role admin client (see lib/supabase/admin.ts) — reminders and
 * push_subscriptions belong to many different users, which RLS would
 * otherwise make impossible to query in one pass, exactly like every
 * other privileged server-side path in this project.
 */

export interface ProcessDueRemindersResult {
  /** How many due-and-in-window occurrences the query returned this run. */
  candidates: number;
  /** Occurrence resolved to "sent" (at least one subscription received it). */
  sent: number;
  /** Occurrence resolved to "failed" (subscriptions existed, all failed) this run. */
  failed: number;
  /** Occurrence resolved to "skipped" (no active subscriptions) this run. */
  skipped: number;
  /** An actively-leased claim already exists (concurrent run) — never sent here (Stage 37 §76). */
  alreadyLeased: number;
  /** A 'failed'+retryable occurrence hasn't reached its backoff instant yet — never sent here (migration-review §5). */
  retryPending: number;
  /** Attempt cap reached (either directly, or self-healed from a stale expired lease) — permanently failed, never sent here (migration-review §1). */
  exhausted: number;
  /** Already resolved 'sent', or permanently 'failed' (non-retryable) — never sent here. */
  terminal: number;
  /** The reminder is currently dismissed — never claimed, never sent (Stage 37 §61). */
  skippedDismissed: number;
  /** The reminder was rescheduled or deleted between being read as a candidate and being claimed — never sent here (Stage 37 §60/§59). */
  staleOrGone: number;
}

function emptyResult(candidates = 0): ProcessDueRemindersResult {
  return {
    candidates,
    sent: 0,
    failed: 0,
    skipped: 0,
    alreadyLeased: 0,
    retryPending: 0,
    exhausted: 0,
    terminal: 0,
    skippedDismissed: 0,
    staleOrGone: 0,
  };
}

interface DueCandidate {
  reminderId: string;
  userId: string;
  libraryItemId: string;
  occurrenceVersion: string;
}

function parseDueCandidates(data: unknown): DueCandidate[] {
  if (!Array.isArray(data)) return [];
  const candidates: DueCandidate[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.reminder_id === "string" &&
      typeof record.user_id === "string" &&
      typeof record.library_item_id === "string" &&
      typeof record.occurrence_version === "string"
    ) {
      candidates.push({
        reminderId: record.reminder_id,
        userId: record.user_id,
        libraryItemId: record.library_item_id,
        occurrenceVersion: record.occurrence_version,
      });
    }
  }
  return candidates;
}

type ClaimResult =
  | { status: "not_found" }
  | { status: "stale" }
  | { status: "skipped_dismissed" }
  | { status: "already_leased" }
  | { status: "retry_pending" }
  | { status: "exhausted" }
  | { status: "terminal" }
  | { status: "claimed"; deliveryId: string; attemptCount: number };

/** Mirrors claim_reminder_delivery's full state machine (see that function's own doc comment in 0017_stage37_web_push.sql) — every status the database can return has an explicit, distinct branch here; nothing falls through to a guessed default. */
async function claimOccurrence(admin: SupabaseClient, candidate: DueCandidate): Promise<ClaimResult> {
  const { data, error } = await admin.rpc("claim_reminder_delivery", {
    p_reminder_id: candidate.reminderId,
    p_occurrence_version: candidate.occurrenceVersion,
  });
  if (error) throw error;

  const record = (data ?? {}) as Record<string, unknown>;
  if (record.status === "claimed" && typeof record.deliveryId === "string") {
    return { status: "claimed", deliveryId: record.deliveryId, attemptCount: typeof record.attemptCount === "number" ? record.attemptCount : 1 };
  }
  if (record.status === "stale") return { status: "stale" };
  if (record.status === "skipped_dismissed") return { status: "skipped_dismissed" };
  if (record.status === "already_leased") return { status: "already_leased" };
  if (record.status === "retry_pending") return { status: "retry_pending" };
  if (record.status === "exhausted") return { status: "exhausted" };
  if (record.status === "terminal") return { status: "terminal" };
  return { status: "not_found" };
}

async function sendToOneSubscription(admin: SupabaseClient, subscription: PushSubscriptionRow, payload: NotificationPayload): Promise<SubscriptionSendOutcome> {
  const keys: PushSubscriptionKeys = { endpoint: subscription.endpoint, p256dh: subscription.p256dh, authKey: subscription.auth_key };
  const result = await sendWebPush(keys, payload);

  if (result.ok) {
    await admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", subscription.id);
    return { subscriptionId: subscription.id, outcome: "sent" };
  }

  const failureClass = classifyPushFailure(result.statusCode);
  // Stage 37 §29/§30 — only a confirmed-gone endpoint (404/410) ever
  // disables the subscription row; a config/auth error or a transient
  // failure never touches it.
  if (shouldDisableSubscription(failureClass)) {
    await admin.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", subscription.id);
  }

  if (failureClass === "permanent") return { subscriptionId: subscription.id, outcome: "permanent_failure", statusCode: result.statusCode ?? 0 };
  if (failureClass === "config_error") return { subscriptionId: subscription.id, outcome: "config_error", statusCode: result.statusCode ?? 0 };
  return { subscriptionId: subscription.id, outcome: "retryable_failure", statusCode: result.statusCode };
}

async function deliverClaimedOccurrence(
  admin: SupabaseClient,
  deliveryId: string,
  attemptCount: number,
  candidate: DueCandidate,
  itemTitle: string,
): Promise<"sent" | "failed" | "skipped"> {
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("*")
    .eq("user_id", candidate.userId)
    .is("disabled_at", null)
    .returns<PushSubscriptionRow[]>();
  const subscriptions = subs ?? [];

  const payload = buildReminderNotificationPayload({
    reminderId: candidate.reminderId,
    occurrenceVersion: candidate.occurrenceVersion,
    libraryItemId: candidate.libraryItemId,
    itemTitle,
  });

  // Stage 37 §32 — zero active subscriptions is a normal, silent skip: the
  // reminder is fine, it just has nowhere to deliver to yet. In practice
  // this is now rare (list_due_reminder_candidates already excludes a
  // reminder whose owner has zero active subscriptions), reached only by
  // the narrow race where one existed a moment ago but is gone by now.
  const results = subscriptions.length === 0 ? [] : await mapWithConcurrency(subscriptions, SEND_CONCURRENCY, (sub) => sendToOneSubscription(admin, sub, payload));

  const outcome = resolveDeliveryOutcome(results);
  // Migration-review §5 / final-review-pass §3 — a retryable failure
  // schedules its next eligible attempt via backoff; a skip schedules a
  // flat defer (never consuming attempt budget — see
  // claim_reminder_delivery's own doc comment for why these are
  // deliberately different mechanisms); sent/permanently-failed clear it.
  let nextAttemptAt: string | null = null;
  if (outcome.status === "failed" && outcome.retryable) {
    nextAttemptAt = new Date(Date.now() + retryBackoffMinutes(attemptCount) * 60_000).toISOString();
  } else if (outcome.status === "skipped") {
    nextAttemptAt = new Date(Date.now() + SKIPPED_RETRY_DEFER_MINUTES * 60_000).toISOString();
  }

  await admin
    .from("reminder_deliveries")
    .update({ status: outcome.status, retryable: outcome.retryable, results, next_attempt_at: nextAttemptAt, completed_at: new Date().toISOString() })
    .eq("id", deliveryId);

  return outcome.status;
}

/**
 * Runs one bounded batch of due-reminder delivery. Idempotent and safe to
 * call repeatedly/concurrently (see claim_reminder_delivery's own
 * guarantee) — a scheduler retry, overlap, or manual re-run can never
 * double-send a given occurrence.
 */
export async function processDueReminders(admin: SupabaseClient, now: Date = new Date()): Promise<ProcessDueRemindersResult> {
  if (!isPushConfigured()) throw new Error("push_not_configured");

  const { data, error } = await admin.rpc("list_due_reminder_candidates", {
    p_now: now.toISOString(),
    p_catchup_minutes: CATCHUP_WINDOW_MINUTES,
    p_limit: MAX_DUE_REMINDERS_PER_RUN,
  });
  if (error) throw error;

  const candidates = parseDueCandidates(data);
  if (candidates.length === 0) return emptyResult(0);

  const itemIds = Array.from(new Set(candidates.map((candidate) => candidate.libraryItemId)));
  const { data: items } = await admin.from("library_items").select("id, title").in("id", itemIds).returns<{ id: string; title: string }[]>();
  const titleById = new Map((items ?? []).map((item) => [item.id, item.title]));

  const result = emptyResult(candidates.length);

  // Sequential across occurrences (each occurrence internally fans out to
  // its own subscriptions with bounded concurrency above) — occurrences
  // are independent reminders/users, so this is simplicity over squeezing
  // out extra parallelism the batch size (Stage 37 §40, max 50) doesn't
  // need.
  for (const candidate of candidates) {
    const claim = await claimOccurrence(admin, candidate);
    // Mirrors claim_reminder_delivery's full state machine exhaustively —
    // every branch is named explicitly, nothing falls through to a catch-
    // all "else" (migration-review §6).
    if (claim.status === "not_found" || claim.status === "stale") {
      result.staleOrGone += 1;
      continue;
    }
    if (claim.status === "skipped_dismissed") {
      result.skippedDismissed += 1;
      continue;
    }
    if (claim.status === "already_leased") {
      result.alreadyLeased += 1;
      continue;
    }
    if (claim.status === "retry_pending") {
      result.retryPending += 1;
      continue;
    }
    if (claim.status === "exhausted") {
      result.exhausted += 1;
      continue;
    }
    if (claim.status === "terminal") {
      result.terminal += 1;
      continue;
    }

    const outcome = await deliverClaimedOccurrence(
      admin,
      claim.deliveryId,
      claim.attemptCount,
      candidate,
      titleById.get(candidate.libraryItemId) ?? "Your reminder",
    );
    result[outcome] += 1;
  }

  return result;
}
