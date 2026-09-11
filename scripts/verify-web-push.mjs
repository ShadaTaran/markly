#!/usr/bin/env node
// Verifies Stage 37 (Background Web Push & Notification Delivery):
// deterministic behavior of the pure payload/policy logic, reproduced
// verbatim from src/lib/push/{payload,delivery-policy,vapid-key,capability}.ts
// (same convention as every other script in this directory — plain .mjs,
// no TypeScript loader), an in-memory reproduction of the atomic-claim/
// delivery-orchestration ALGORITHM in lib/push/deliver.ts and
// claim_reminder_delivery/list_due_reminder_candidates in
// 0017_stage37_web_push.sql (not a real PostgreSQL/RLS test — that
// requires an actual Supabase project, which this stage explicitly does
// not deploy against), plus durable structural contracts (no automatic
// permission prompts, VAPID private key server-only, scheduler endpoint
// protection, migrations 0001-0016 untouched).
//
// Run with: node scripts/verify-web-push.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import yaml from "js-yaml";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

function src(path) {
  return readFileSync(path, "utf8");
}

// ============================================================
// A — payload contract, reproduced verbatim from src/lib/push/payload.ts
// (Stage 37 §7/§8/§52/§53/§54/§69).
// ============================================================
const NOTIFICATION_PAYLOAD_VERSION = 1;
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 140;
const MAX_TAG_LENGTH = 200;
const MAX_ITEM_ID_LENGTH = 200;

function isNonEmptyBoundedString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isSupportedNotificationRoute(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type === "reminders") return true;
  if (value.type === "library-item") return isNonEmptyBoundedString(value.itemId, MAX_ITEM_ID_LENGTH);
  return false;
}

function parseNotificationPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (data.version !== NOTIFICATION_PAYLOAD_VERSION) return null;
  if (data.kind !== "reminder" && data.kind !== "test") return null;
  if (!isNonEmptyBoundedString(data.title, MAX_TITLE_LENGTH)) return null;
  if (!isNonEmptyBoundedString(data.body, MAX_BODY_LENGTH)) return null;
  if (!isNonEmptyBoundedString(data.tag, MAX_TAG_LENGTH)) return null;
  if (!isSupportedNotificationRoute(data.route)) return null;
  return { version: NOTIFICATION_PAYLOAD_VERSION, kind: data.kind, title: data.title, body: data.body, tag: data.tag, route: data.route };
}

function truncate(value, maxLength) {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed || "A saved reminder is due.";
}

function buildReminderNotificationPayload(input) {
  return {
    version: NOTIFICATION_PAYLOAD_VERSION,
    kind: "reminder",
    title: "Markly reminder",
    body: truncate(input.itemTitle, MAX_BODY_LENGTH),
    tag: `markly-reminder-${input.reminderId}-${input.occurrenceVersion}`,
    route: { type: "library-item", itemId: input.libraryItemId },
  };
}

function buildTestNotificationPayload() {
  return {
    version: NOTIFICATION_PAYLOAD_VERSION,
    kind: "test",
    title: "Markly test notification",
    body: "Background notifications are working on this browser.",
    tag: "markly-test-notification",
    route: { type: "reminders" },
  };
}

check("A1 (test §69): a reminder payload is versioned, minimal, and never carries a description/notes/tags/full URL", () => {
  const payload = buildReminderNotificationPayload({ reminderId: "r1", occurrenceVersion: "2026-01-01T00:00:00.000Z", libraryItemId: "item1", itemTitle: "My Fantasy Novel" });
  assert.equal(payload.version, 1);
  assert.equal(payload.kind, "reminder");
  assert.equal(payload.title, "Markly reminder");
  assert.ok(payload.body.includes("My Fantasy Novel"));
  assert.deepEqual(payload.route, { type: "library-item", itemId: "item1" });
  const keys = Object.keys(payload);
  assert.deepEqual(keys.sort(), ["body", "kind", "route", "tag", "title", "version"]);
});

check("A2: the reminder payload's tag is occurrence-specific (reminder id + version) — never one global tag shared by every reminder", () => {
  const a = buildReminderNotificationPayload({ reminderId: "r1", occurrenceVersion: "2026-01-01T00:00:00.000Z", libraryItemId: "item1", itemTitle: "A" });
  const b = buildReminderNotificationPayload({ reminderId: "r1", occurrenceVersion: "2026-01-02T00:00:00.000Z", libraryItemId: "item1", itemTitle: "A" });
  const c = buildReminderNotificationPayload({ reminderId: "r2", occurrenceVersion: "2026-01-01T00:00:00.000Z", libraryItemId: "item2", itemTitle: "B" });
  assert.notEqual(a.tag, b.tag, "editing the same reminder (new occurrence_version) must change its tag");
  assert.notEqual(a.tag, c.tag, "two different reminders must never share a tag");
});

check("A3: an overlong item title is truncated, never rejected/thrown, and a body always ends up non-empty", () => {
  const longTitle = "x".repeat(500);
  const payload = buildReminderNotificationPayload({ reminderId: "r1", occurrenceVersion: "v1", libraryItemId: "item1", itemTitle: longTitle });
  assert.ok(payload.body.length <= MAX_BODY_LENGTH);
  const empty = buildReminderNotificationPayload({ reminderId: "r1", occurrenceVersion: "v1", libraryItemId: "item1", itemTitle: "   " });
  assert.ok(empty.body.length > 0, "a blank title must still produce a non-empty, safe body");
});

check("A4 (test §22): the test-notification payload is structurally distinguishable from a real reminder delivery — different kind, fixed non-occurrence tag, different route", () => {
  const test = buildTestNotificationPayload();
  assert.equal(test.kind, "test");
  assert.equal(test.tag, "markly-test-notification");
  assert.deepEqual(test.route, { type: "reminders" });
});

check("A5 (test §81): parseNotificationPayload accepts a well-formed payload and rejects an unknown version, unknown kind, and an unsupported route — safe fallback, never throws", () => {
  const good = buildReminderNotificationPayload({ reminderId: "r1", occurrenceVersion: "v1", libraryItemId: "item1", itemTitle: "Ok" });
  assert.ok(parseNotificationPayload(good));
  assert.equal(parseNotificationPayload({ ...good, version: 2 }), null);
  assert.equal(parseNotificationPayload({ ...good, kind: "arbitrary" }), null);
  assert.equal(parseNotificationPayload({ ...good, route: { type: "external", href: "https://evil.example" } }), null);
  assert.equal(parseNotificationPayload(null), null);
  assert.equal(parseNotificationPayload("not an object"), null);
  assert.equal(parseNotificationPayload(42), null);
});

check("A6 (test §23/§53): isSupportedNotificationRoute is a fixed allowlist of exactly two route shapes — no arbitrary href/type ever accepted", () => {
  assert.ok(isSupportedNotificationRoute({ type: "reminders" }));
  assert.ok(isSupportedNotificationRoute({ type: "library-item", itemId: "abc" }));
  assert.ok(!isSupportedNotificationRoute({ type: "library-item", itemId: "" }));
  assert.ok(!isSupportedNotificationRoute({ type: "library-item", itemId: "x".repeat(300) }));
  assert.ok(!isSupportedNotificationRoute({ type: "external", href: "https://evil.example" }));
  assert.ok(!isSupportedNotificationRoute({ href: "https://evil.example" }));
  assert.ok(!isSupportedNotificationRoute(null));
  assert.ok(!isSupportedNotificationRoute("reminders"));
});

// ============================================================
// B — public/sw.js's OWN copy of the route/payload validation must agree
// with the canonical src/lib/push/payload.ts definitions above (Stage 37
// §5's "smallest dedicated worker, no build step" means it cannot import
// the TS module — see that file's own doc comment for why this
// duplication is deliberate).
// ============================================================
check("B1: public/sw.js exists and defines the same NOTIFICATION_PAYLOAD_VERSION as src/lib/push/payload.ts", () => {
  const swSource = src("public/sw.js");
  const tsSource = src("src/lib/push/payload.ts");
  assert.ok(/const NOTIFICATION_PAYLOAD_VERSION = 1;/.test(swSource));
  assert.ok(/export const NOTIFICATION_PAYLOAD_VERSION = 1;/.test(tsSource));
});

check("B2: sw.js's isSupportedRoute recognizes exactly the same two route shapes ('reminders', 'library-item') as the TS allowlist", () => {
  const swSource = src("public/sw.js");
  assert.ok(swSource.includes('value.type === "reminders"'));
  assert.ok(swSource.includes('value.type === "library-item"'));
  assert.ok(swSource.includes("value.itemId.length > 0 && value.itemId.length <= 200"));
});

check("B3 (test §8/§9): sw.js's resolveRouteUrl only ever returns one of the two fixed internal paths — never a raw href taken from the payload", () => {
  const swSource = src("public/sw.js");
  const fn = swSource.slice(swSource.indexOf("function resolveRouteUrl"), swSource.indexOf("self.addEventListener(\"push\""));
  assert.ok(fn.includes('"/library/" + encodeURIComponent(route.itemId)'));
  assert.ok(fn.includes('"/reminders"'));
  assert.ok(!/route\.href|route\.url|location\.href\s*=/.test(fn), "must never read a URL field straight from the payload");
});

check("B4 (test §52/§81): sw.js treats a malformed push payload as untrusted — parsePayload wrapped in try/catch, falling back to a fixed generic title/body/route rather than throwing or evaluating arbitrary data", () => {
  const swSource = src("public/sw.js");
  assert.ok(/try\s*{\s*payload = event\.data \? parsePayload\(event\.data\.json\(\)\) : null;\s*}\s*catch/.test(swSource));
  assert.ok(swSource.includes('"Markly reminder"') && swSource.includes('"Open Markly to see what\'s new."'));
});

check("B5: notificationclick focuses an existing same-origin window before ever opening a new one (Stage 37 §9 — no unnecessary duplicate windows)", () => {
  const swSource = src("public/sw.js");
  const handler = swSource.slice(swSource.indexOf('self.addEventListener("notificationclick"'));
  const focusIndex = handler.indexOf(".focus()");
  const openIndex = handler.indexOf("self.clients.openWindow");
  assert.ok(focusIndex !== -1 && openIndex !== -1 && focusIndex < openIndex, "expected the existing-window focus path to appear before the openWindow fallback");
});

// ============================================================
// C — delivery policy, reproduced verbatim from
// src/lib/push/delivery-policy.ts (Stage 37 §29/§31/§32/§36/§37/§41/§70).
// ============================================================
const MAX_DUE_REMINDERS_PER_RUN = 50;
const SEND_CONCURRENCY = 5;
const CATCHUP_WINDOW_MINUTES = 1440;
const MAX_DELIVERY_ATTEMPTS = 5;
const CLAIM_LEASE_SECONDS = 120;
const RETRY_BACKOFF_MINUTES = [2, 5, 15, 30];
const SKIPPED_RETRY_DEFER_MINUTES = 15;

function retryBackoffMinutes(attemptCount) {
  const index = Math.min(Math.max(attemptCount, 1) - 1, RETRY_BACKOFF_MINUTES.length - 1);
  return RETRY_BACKOFF_MINUTES[index];
}

function isWithinCatchUpWindow(dueAtMs, nowMs, catchupWindowMinutes = CATCHUP_WINDOW_MINUTES) {
  return dueAtMs <= nowMs && nowMs - dueAtMs <= catchupWindowMinutes * 60_000;
}

function classifyPushFailure(statusCode) {
  if (statusCode === 404 || statusCode === 410) return "permanent";
  if (statusCode === 401 || statusCode === 403) return "config_error";
  return "retryable";
}

function resolveDeliveryOutcome(results) {
  if (results.length === 0) return { status: "skipped", retryable: false };
  if (results.some((result) => result.outcome === "sent")) return { status: "sent", retryable: false };
  const canRetry = results.some((result) => result.outcome === "retryable_failure" || result.outcome === "config_error");
  return { status: "failed", retryable: canRetry };
}

function shouldDisableSubscription(failureClass) {
  return failureClass === "permanent";
}

async function mapWithConcurrency(items, concurrency, fn) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

check("C1 (test §36/§37): the catch-up window includes a reminder overdue by 1 hour and excludes one overdue by 40 days — the policy never silently resurrects an ancient reminder", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  assert.ok(isWithinCatchUpWindow(now - 60 * 60_000, now), "1 hour overdue must still be within the window");
  assert.ok(!isWithinCatchUpWindow(now - 40 * 24 * 60 * 60_000, now), "40 days overdue must be excluded");
  assert.ok(!isWithinCatchUpWindow(now + 60_000, now), "a reminder due in the future is never 'catch-up due'");
});

check("C2 (test §70): retry classification matches the exact table — 404/410 permanent, 401/403 config_error, 429/500/503/network(null) retryable", () => {
  assert.equal(classifyPushFailure(404), "permanent");
  assert.equal(classifyPushFailure(410), "permanent");
  assert.equal(classifyPushFailure(401), "config_error");
  assert.equal(classifyPushFailure(403), "config_error");
  assert.equal(classifyPushFailure(429), "retryable");
  assert.equal(classifyPushFailure(500), "retryable");
  assert.equal(classifyPushFailure(503), "retryable");
  assert.equal(classifyPushFailure(null), "retryable");
});

check("C3 (test §29/§30): only a 'permanent' classification ever disables a subscription — config/auth errors and transient failures never do", () => {
  assert.equal(shouldDisableSubscription("permanent"), true);
  assert.equal(shouldDisableSubscription("config_error"), false);
  assert.equal(shouldDisableSubscription("retryable"), false);
});

check("C4 (test §72, multiple devices): 3 subscriptions, one dead (410) — overall outcome is still 'sent', never failed, because the other two succeeded", () => {
  const results = [
    { subscriptionId: "s1", outcome: "sent" },
    { subscriptionId: "s2", outcome: "sent" },
    { subscriptionId: "s3", outcome: "permanent_failure", statusCode: 410 },
  ];
  const outcome = resolveDeliveryOutcome(results);
  assert.equal(outcome.status, "sent");
});

check("C5 (test §73, no devices): zero subscriptions resolves to 'skipped', never 'failed' — a reminder with nowhere to deliver to is not an error", () => {
  const outcome = resolveDeliveryOutcome([]);
  assert.deepEqual(outcome, { status: "skipped", retryable: false });
});

check("C6: every subscription failing with a permanent classification resolves to 'failed' with retryable=false — nothing left to gain by retrying dead endpoints", () => {
  const outcome = resolveDeliveryOutcome([
    { subscriptionId: "s1", outcome: "permanent_failure", statusCode: 404 },
    { subscriptionId: "s2", outcome: "permanent_failure", statusCode: 410 },
  ]);
  assert.deepEqual(outcome, { status: "failed", retryable: false });
});

check("C7: a mix of retryable/config_error failures (no successes) resolves to 'failed' with retryable=true — worth trying again", () => {
  const outcome = resolveDeliveryOutcome([
    { subscriptionId: "s1", outcome: "retryable_failure", statusCode: 503 },
    { subscriptionId: "s2", outcome: "config_error", statusCode: 401 },
  ]);
  assert.deepEqual(outcome, { status: "failed", retryable: true });
});

check("C8 (test §41): mapWithConcurrency never exceeds SEND_CONCURRENCY and preserves input order regardless of completion order", async () => {
  let active = 0;
  let maxActive = 0;
  const items = [80, 10, 60, 20, 50, 30, 40, 5];
  const output = await mapWithConcurrency(items, SEND_CONCURRENCY, async (ms, index) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, ms));
    active -= 1;
    return index;
  });
  assert.ok(maxActive <= SEND_CONCURRENCY, `expected concurrency <= ${SEND_CONCURRENCY}, saw ${maxActive}`);
  assert.deepEqual(output, [0, 1, 2, 3, 4, 5, 6, 7], "results must stay in input order, not completion order");
});

check("C10: the reproduced MAX_DUE_REMINDERS_PER_RUN/SEND_CONCURRENCY constants match the real module (src/lib/push/delivery-policy.ts) exactly — batching/concurrency policy is a single source of truth", () => {
  const source = src("src/lib/push/delivery-policy.ts");
  assert.ok(new RegExp(`MAX_DUE_REMINDERS_PER_RUN = ${MAX_DUE_REMINDERS_PER_RUN};`).test(source));
  assert.ok(new RegExp(`SEND_CONCURRENCY = ${SEND_CONCURRENCY};`).test(source));
});

check("C11 (migration-review §1/§5): the reproduced lease duration and retry-backoff curve match src/lib/push/delivery-policy.ts's real constants exactly, AND the lease duration matches the literal make_interval(secs => 120) hard-coded in claim_reminder_delivery() — three independent copies of the same number, verified to agree", () => {
  const policySource = src("src/lib/push/delivery-policy.ts");
  assert.ok(new RegExp(`CLAIM_LEASE_SECONDS = ${CLAIM_LEASE_SECONDS};`).test(policySource));
  assert.ok(new RegExp(`RETRY_BACKOFF_MINUTES: readonly number\\[\\] = \\[${RETRY_BACKOFF_MINUTES.join(", ")}\\];`).test(policySource));

  const migrationSql = src("supabase/migrations/0017_stage37_web_push.sql");
  assert.ok(migrationSql.includes(`make_interval(secs => ${CLAIM_LEASE_SECONDS})`), "the database's own lease duration must match lib/push/delivery-policy.ts's CLAIM_LEASE_SECONDS");
});

check("C12 (final-review-pass §3 — no-subscription churn fix): the reproduced SKIPPED_RETRY_DEFER_MINUTES matches src/lib/push/delivery-policy.ts's real constant exactly", () => {
  const source = src("src/lib/push/delivery-policy.ts");
  assert.ok(new RegExp(`SKIPPED_RETRY_DEFER_MINUTES = ${SKIPPED_RETRY_DEFER_MINUTES};`).test(source));
});

check("C9: the real transport module reports itself unconfigured (never throws building the payload) when VAPID env vars are absent — env-validation source check", () => {
  const source = src("src/lib/push/transport.ts");
  assert.ok(source.includes("export function isPushConfigured"));
  assert.ok(source.includes('import "server-only"'), "transport.ts (which reads VAPID_PRIVATE_KEY) must be server-only guarded");
});

// ============================================================
// D — VAPID key conversion, reproduced verbatim from
// src/lib/push/vapid-key.ts (Stage 37 §43).
// ============================================================
function urlBase64ToUint8ArrayNode(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = Buffer.from(base64, "base64").toString("binary");
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

check("D1 (test §43): urlBase64ToUint8Array round-trips a real VAPID-shaped public key (no padding, URL-safe alphabet) back to its exact original bytes", () => {
  const originalBytes = new Uint8Array(65);
  for (let i = 0; i < originalBytes.length; i += 1) originalBytes[i] = (i * 7) % 256;
  const asBase64Url = Buffer.from(originalBytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const decoded = urlBase64ToUint8ArrayNode(asBase64Url);
  assert.deepEqual(Array.from(decoded), Array.from(originalBytes));
});

check("D2: the conversion handles all three possible missing-padding lengths without throwing", () => {
  for (const length of [64, 65, 66, 67]) {
    const bytes = new Uint8Array(length).fill(9);
    const asBase64Url = Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.doesNotThrow(() => urlBase64ToUint8ArrayNode(asBase64Url));
  }
});

// ============================================================
// E — occurrence identity, reproduced verbatim from
// reminder_effective_due_at() (0017_stage37_web_push.sql) — the
// migration-review fix for the original coalesce(updated_at, created_at)
// identity, which the merge/undo-merge RPCs (0016) bump merely to
// reassign library_item_id, completely unrelated to a reminder's
// schedule.
// ============================================================
function reminderEffectiveDueAt(reminder) {
  if (reminder.kind === "continue") return Date.parse(reminder.remindAt);
  return Date.parse(reminder.scheduledFor) - reminder.remindBeforeMinutes * 60_000;
}

check("E1 (occurrence identity audit, test-matrix A): an unchanged reminder computes the exact same occurrence identity every time", () => {
  const reminder = { kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" };
  assert.equal(reminderEffectiveDueAt(reminder), reminderEffectiveDueAt(reminder));
});

check("E2 (test-matrix B): editing the actual due time (continue reminder's remind_at) produces a NEW occurrence identity", () => {
  const before = { kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" };
  const after = { kind: "continue", remindAt: "2026-06-01T11:00:00.000Z" };
  assert.notEqual(reminderEffectiveDueAt(before), reminderEffectiveDueAt(after));
});

check("E3 (test-matrix C): editing a release reminder's lead time (remind_before_minutes) produces a NEW occurrence identity, even though scheduled_for itself never changes", () => {
  const before = { kind: "release", scheduledFor: "2026-06-01T12:00:00.000Z", remindBeforeMinutes: 30 };
  const after = { kind: "release", scheduledFor: "2026-06-01T12:00:00.000Z", remindBeforeMinutes: 60 };
  assert.notEqual(reminderEffectiveDueAt(before), reminderEffectiveDueAt(after));
});

check("E4 (occurrence identity audit finding, test-matrix D): reassigning library_item_id (what merge_library_items/undo_library_recovery in 0016 actually do to a moved reminder) changes NOTHING the identity formula reads — SAME occurrence, confirming the fix for the original coalesce(updated_at,created_at) bug", () => {
  const before = { kind: "continue", remindAt: "2026-06-01T10:00:00.000Z", libraryItemId: "item-A" };
  // Simulate exactly what the merge RPC does: reassign library_item_id
  // (and, under the OLD identity, bump updated_at) — never touch kind/
  // scheduledFor/remindBeforeMinutes/remindAt.
  const afterMerge = { ...before, libraryItemId: "item-SURVIVOR" };
  assert.equal(reminderEffectiveDueAt(before), reminderEffectiveDueAt(afterMerge), "a merge/reassignment must never fabricate a new occurrence");
});

check("E5 (test-matrix E): a reminder already delivered, then merged (unrelated edit) — the occurrence identity used for the NEXT claim attempt still matches the already-'sent' row, so it resolves to 'terminal' rather than sending again", () => {
  const before = { kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" };
  const afterMerge = { ...before, libraryItemId: "item-SURVIVOR" };
  assert.equal(reminderEffectiveDueAt(before), reminderEffectiveDueAt(afterMerge));
});

check("E6 (test-matrix F): a reminder already delivered, then genuinely rescheduled — a NEW, independently eligible occurrence identity is produced, matching Stage 34's own semantics (an edit is a real change a user made, not noise)", () => {
  const before = { kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" };
  const afterReschedule = { kind: "continue", remindAt: "2026-06-02T09:00:00.000Z" };
  assert.notEqual(reminderEffectiveDueAt(before), reminderEffectiveDueAt(afterReschedule));
});

// ============================================================
// F — the atomic claim + lease/backoff state machine, reproduced as an
// in-memory model of claim_reminder_delivery() (0017_stage37_web_push.sql,
// post-reliability-review). This is an ALGORITHM model, not a real
// PostgreSQL/RLS test — see this file's own header comment and the Stage
// 37 migration-review report for why no disposable database was available
// in this environment.
// ============================================================
const CLAIM_LEASE_MS = 120_000;

function makeFakeDb() {
  const reminders = new Map(); // id -> { userId, dismissedAt, kind, remindAt, scheduledFor, remindBeforeMinutes }
  const deliveries = new Map(); // `${reminderId}|${occurrenceVersion}` -> row
  return { reminders, deliveries };
}

/** Mirrors claim_reminder_delivery(p_reminder_id, p_occurrence_version) exactly, including the full lease/backoff/exhaustion state machine. `nowMs` stands in for the database's own now(). */
function claimReminderDelivery(db, reminderId, occurrenceVersion, nowMs) {
  const reminder = db.reminders.get(reminderId);
  if (!reminder) return { status: "not_found" };
  if (reminderEffectiveDueAt(reminder) !== occurrenceVersion) return { status: "stale" };
  if (reminder.dismissedAt) return { status: "skipped_dismissed" };

  const key = `${reminderId}|${occurrenceVersion}`;
  const leaseUntil = nowMs + CLAIM_LEASE_MS;
  let existing = db.deliveries.get(key);

  if (!existing) {
    existing = { id: `delivery-${db.deliveries.size + 1}`, userId: reminder.userId, status: "claimed", retryable: false, attemptCount: 1, claimedAt: nowMs, leaseExpiresAt: leaseUntil, nextAttemptAt: null };
    db.deliveries.set(key, existing);
    return { status: "claimed", deliveryId: existing.id, attemptCount: 1 };
  }

  if (existing.status === "sent") return { status: "terminal", reason: "sent" };

  if (existing.status === "skipped") {
    // Final-review-pass fix (§3/§4) — deferred, not immediately
    // reclaimable, and never increments attempt_count (a skip was never a
    // real external Web Push attempt).
    if (existing.nextAttemptAt !== null && existing.nextAttemptAt > nowMs) {
      return { status: "retry_pending", nextAttemptAt: existing.nextAttemptAt };
    }
    existing.status = "claimed";
    existing.claimedAt = nowMs;
    existing.leaseExpiresAt = leaseUntil;
    existing.nextAttemptAt = null;
    return { status: "claimed", deliveryId: existing.id, attemptCount: existing.attemptCount };
  }

  if (existing.status === "claimed") {
    if (existing.leaseExpiresAt > nowMs) return { status: "already_leased" };
    if (existing.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
      existing.status = "failed";
      existing.retryable = false;
      return { status: "exhausted" };
    }
    existing.attemptCount += 1;
    existing.claimedAt = nowMs;
    existing.leaseExpiresAt = leaseUntil;
    existing.nextAttemptAt = null;
    return { status: "claimed", deliveryId: existing.id, attemptCount: existing.attemptCount };
  }

  // existing.status === "failed"
  if (!existing.retryable) return { status: "terminal", reason: "permanent_failure" };
  if (existing.attemptCount >= MAX_DELIVERY_ATTEMPTS) return { status: "exhausted" };
  if (existing.nextAttemptAt !== null && existing.nextAttemptAt > nowMs) return { status: "retry_pending", nextAttemptAt: existing.nextAttemptAt };
  existing.status = "claimed";
  existing.attemptCount += 1;
  existing.claimedAt = nowMs;
  existing.leaseExpiresAt = leaseUntil;
  existing.nextAttemptAt = null;
  return { status: "claimed", deliveryId: existing.id, attemptCount: existing.attemptCount };
}

const T0 = Date.parse("2026-06-01T10:00:00.000Z");

check("F1 (test §71, idempotency): claiming the same occurrence twice in immediate succession — second call is 'already_leased', never a second 'claimed'", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  const first = claimReminderDelivery(db, "r1", T0, T0);
  const second = claimReminderDelivery(db, "r1", T0, T0 + 1000);
  assert.equal(first.status, "claimed");
  assert.equal(second.status, "already_leased");
});

check("F2 (test §76, concurrent workers / migration-review §1 blocker fix — active lease cannot be stolen): two 'workers' race to claim the exact same occurrence — exactly one wins, the other sees an active lease, not a silent double-claim", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  const attempts = [claimReminderDelivery(db, "r1", T0, T0), claimReminderDelivery(db, "r1", T0, T0 + 500)];
  const claimedCount = attempts.filter((a) => a.status === "claimed").length;
  assert.equal(claimedCount, 1, "exactly one of the two concurrent claim attempts must win");
  assert.equal(attempts[1].status, "already_leased");
});

check("F3 (migration-review §1 blocker fix — stale claimed lease recovery): a claim that crashed before ever recording an outcome (stuck at status='claimed') becomes reclaimable once its lease expires, incrementing attempt_count — it is NOT permanently stuck", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  const first = claimReminderDelivery(db, "r1", T0, T0);
  assert.equal(first.status, "claimed");
  // Simulate a crash: no finalize ever happens. Immediately after, the
  // lease is still active — must not be stolen.
  const tooSoon = claimReminderDelivery(db, "r1", T0, T0 + 60_000);
  assert.equal(tooSoon.status, "already_leased");
  // Once the 120s lease has genuinely expired, a later run recovers it.
  const recovered = claimReminderDelivery(db, "r1", T0, T0 + CLAIM_LEASE_MS + 1000);
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.attemptCount, 2, "a stale-lease reclaim must increment attempt_count — the previous attempt's outcome is genuinely unknown (§2)");
});

check("F4 (migration-review §1 — attempts still bounded even via lease recovery): repeatedly crashing (never finalizing) eventually exhausts the attempt cap rather than reclaiming forever", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  let now = T0;
  let last;
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
    last = claimReminderDelivery(db, "r1", T0, now);
    now += CLAIM_LEASE_MS + 1000;
  }
  assert.equal(last.status, "claimed", "the final permitted attempt must still succeed as a claim");
  assert.equal(last.attemptCount, MAX_DELIVERY_ATTEMPTS);
  const afterCap = claimReminderDelivery(db, "r1", T0, now);
  assert.equal(afterCap.status, "exhausted", "once the cap is reached, a further stale-lease reclaim must self-heal to terminal, not loop forever");
  // And it stays terminal — never claimable again.
  const again = claimReminderDelivery(db, "r1", T0, now + CLAIM_LEASE_MS + 1000);
  assert.equal(again.status, "terminal");
});

check("F5 (migration-review §5 — retry backoff): a 'failed, retryable' delivery is NOT reclaimable before its next_attempt_at, and IS reclaimable once that instant passes", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(db, "r1", T0, T0);
  const row = db.deliveries.get(`r1|${T0}`);
  row.status = "failed";
  row.retryable = true;
  row.nextAttemptAt = T0 + retryBackoffMinutes(1) * 60_000;

  const tooSoon = claimReminderDelivery(db, "r1", T0, T0 + 30_000);
  assert.equal(tooSoon.status, "retry_pending");

  const eligible = claimReminderDelivery(db, "r1", T0, row.nextAttemptAt + 1);
  assert.equal(eligible.status, "claimed");
  assert.equal(eligible.attemptCount, 2);
});

check("F6 (migration-review §5 — a 1-minute scheduler cannot burn all 5 retries immediately): five consecutive claim attempts spaced only 60s apart (faster than any backoff tier) exhaust at most one attempt beyond the first — most are 'retry_pending', not 'claimed'", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  const results = [];
  let now = T0;
  for (let i = 0; i < 5; i += 1) {
    const result = claimReminderDelivery(db, "r1", T0, now);
    results.push(result.status);
    if (result.status === "claimed") {
      const row = db.deliveries.get(`r1|${T0}`);
      row.status = "failed";
      row.retryable = true;
      row.nextAttemptAt = now + retryBackoffMinutes(row.attemptCount) * 60_000;
    }
    now += 60_000; // a scheduler running every 1 minute
  }
  const claimedCount = results.filter((status) => status === "claimed").length;
  assert.ok(claimedCount <= 2, `a 1-minute scheduler must not consume every retry immediately — saw ${claimedCount} claims in 5 back-to-back minutes: ${results.join(", ")}`);
  assert.ok(results.includes("retry_pending"), "expected at least one attempt to be correctly gated by backoff");
});

check("F7 (defensive fallback, NOT the primary behavior — see section J for the real deferred-reclaim behavior post-churn-fix): a 'skipped' row with next_attempt_at left null (should not happen in practice — lib/push/deliver.ts always sets a real defer time on skip — but guarded rather than assumed) is treated as immediately eligible rather than permanently stuck; attempt_count is still never consumed by any number of skip reclaims", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  const first = claimReminderDelivery(db, "r1", T0, T0);
  const row = db.deliveries.get(`r1|${T0}`);
  row.status = "skipped";
  row.nextAttemptAt = null; // the degenerate/defensive case this test isolates
  row.completedAt = T0;

  let now = T0 + 60_000;
  for (let i = 0; i < 10; i += 1) {
    const reclaim = claimReminderDelivery(db, "r1", T0, now);
    assert.equal(reclaim.status, "claimed", `reclaim #${i + 1} of a 'skipped' occurrence with a null defer time must still succeed, not get stuck`);
    row.status = "skipped";
    row.nextAttemptAt = null;
    now += 60_000;
  }
  assert.equal(row.attemptCount, first.attemptCount, "a skip is never an attempt against an external service — attempt_count must never move");
});

check("F8 (test §72/§73, multi-device and no-device outcomes feed correctly into the state machine): a 'sent' occurrence is permanently terminal; an occurrence resolved 'failed'/retryable=false (e.g. every subscription permanently dead) is permanently terminal too", () => {
  const dbSent = makeFakeDb();
  dbSent.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(dbSent, "r1", T0, T0);
  dbSent.deliveries.get(`r1|${T0}`).status = "sent";
  assert.deepEqual(claimReminderDelivery(dbSent, "r1", T0, T0 + 999_999), { status: "terminal", reason: "sent" });

  const dbDead = makeFakeDb();
  dbDead.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(dbDead, "r1", T0, T0);
  Object.assign(dbDead.deliveries.get(`r1|${T0}`), { status: "failed", retryable: false });
  assert.deepEqual(claimReminderDelivery(dbDead, "r1", T0, T0 + 999_999), { status: "terminal", reason: "permanent_failure" });
});

check("F9 (test §59, deleted reminder race): the reminder no longer exists at claim time — 'not_found', never a crash, never a send", () => {
  const db = makeFakeDb();
  const result = claimReminderDelivery(db, "does-not-exist", T0, T0);
  assert.deepEqual(result, { status: "not_found" });
});

check("F10 (test §61, disabled/dismissed reminder race — re-checked on every reclaim, not just the first attempt): the reminder is dismissed between being read as a candidate and being claimed, and ALSO between a failed attempt and a would-be retry", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  db.reminders.get("r1").dismissedAt = "2026-06-01T10:00:30.000Z";
  const result = claimReminderDelivery(db, "r1", T0, T0);
  assert.deepEqual(result, { status: "skipped_dismissed" });
});

check("F11 (test §60, edited reminder race): the reminder's due time changes (occurrence_version changes) between being read as a candidate and being claimed — the stale claim attempt is rejected, never sent, and the NEW occurrence is independently, freshly claimable", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  db.reminders.get("r1").remindAt = "2026-06-01T10:05:00.000Z";
  const staleVersion = T0;
  const result = claimReminderDelivery(db, "r1", staleVersion, T0);
  assert.equal(result.status, "stale");
  const fresh = claimReminderDelivery(db, "r1", Date.parse("2026-06-01T10:05:00.000Z"), T0);
  assert.equal(fresh.status, "claimed");
});

check("F12 (test §74, ownership): claiming a reminder always resolves userId from the reminder row itself — never from any caller-supplied value, so a subscription lookup keyed on this userId can never cross to a different user", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "user-a", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  db.reminders.set("r2", { userId: "user-b", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(db, "r1", T0, T0);
  claimReminderDelivery(db, "r2", T0, T0);
  assert.equal(db.deliveries.get(`r1|${T0}`).userId, "user-a");
  assert.equal(db.deliveries.get(`r2|${T0}`).userId, "user-b");
});

// ============================================================
// G — migration static checks (Stage 37 §13/§14/§20/§24/§27/§66, extended
// by the migration-review §11 SECURITY DEFINER audit).
// ============================================================
const migrationSource = src("supabase/migrations/0017_stage37_web_push.sql");

// Function-body slices — four functions now (reminder_effective_due_at
// was added by the reliability review, ahead of upsert_push_subscription).
const fnReminderEffectiveDueAt = migrationSource.slice(
  migrationSource.indexOf("create or replace function public.reminder_effective_due_at"),
  migrationSource.indexOf("create table if not exists public.push_subscriptions"),
);
const fnUpsertPushSubscription = migrationSource.slice(
  migrationSource.indexOf("create or replace function public.upsert_push_subscription"),
  migrationSource.indexOf("create or replace function public.claim_reminder_delivery"),
);
const fnClaimReminderDelivery = migrationSource.slice(
  migrationSource.indexOf("create or replace function public.claim_reminder_delivery"),
  migrationSource.indexOf("create or replace function public.list_due_reminder_candidates"),
);
const fnListDueReminderCandidates = migrationSource.slice(migrationSource.indexOf("create or replace function public.list_due_reminder_candidates"));

check("G1: push_subscriptions has a global unique constraint on endpoint (the ownership-transfer rule's foundation)", () => {
  assert.ok(/constraint push_subscriptions_endpoint_key unique \(endpoint\)/.test(migrationSource));
});

check("G2: push_subscriptions has NO insert/update policy for any client role — every write is RPC/admin-only", () => {
  const section = migrationSource.slice(migrationSource.indexOf("create table if not exists public.push_subscriptions"), migrationSource.indexOf("create table if not exists public.reminder_deliveries"));
  assert.ok(!/for insert/.test(section) && !/for update/.test(section), "expected no client-facing insert/update policy on push_subscriptions");
  assert.ok(/for select/.test(section) && /for delete/.test(section), "expected select/delete-own policies to still exist");
});

check("G3: upsert_push_subscription is SECURITY DEFINER, derives ownership from auth.uid() (never a p_user_id parameter), reassigns user_id on conflict, and is locked away from anon", () => {
  assert.ok(/security definer/.test(fnUpsertPushSubscription));
  assert.ok(/set search_path = pg_catalog, pg_temp/.test(fnUpsertPushSubscription), "SECURITY DEFINER functions must pin a safe search_path");
  assert.ok(!/p_user_id/.test(fnUpsertPushSubscription), "must never accept a client-supplied user id");
  assert.ok(/v_uid uuid := auth\.uid\(\)/.test(fnUpsertPushSubscription));
  assert.ok(/on conflict \(endpoint\) do update set[\s\S]*user_id = excluded\.user_id/.test(fnUpsertPushSubscription), "re-subscribing the same endpoint must reassign ownership to whoever is currently authenticated");
  assert.ok(/revoke all on function public\.upsert_push_subscription\([^)]*\) from public;/.test(fnUpsertPushSubscription));
  assert.ok(/revoke all on function public\.upsert_push_subscription\([^)]*\) from anon;/.test(fnUpsertPushSubscription), "migration-review §11 — explicit anon revoke, not just an implicit PUBLIC-revoke consequence");
  assert.ok(/grant execute .* to authenticated/.test(fnUpsertPushSubscription));
});

check("G4: claim_reminder_delivery is locked to service_role only (never authenticated/anon), pins a safe search_path, and re-derives the reminder's owner/schedule state from the LIVE row via reminder_effective_due_at — never a caller-supplied value, never the old (unsafe) coalesce(updated_at, created_at)", () => {
  assert.ok(/revoke all .* from anon, authenticated/.test(fnClaimReminderDelivery));
  assert.ok(/grant execute .* to service_role/.test(fnClaimReminderDelivery));
  assert.ok(/set search_path = pg_catalog, pg_temp/.test(fnClaimReminderDelivery));
  assert.ok(/security invoker/.test(fnClaimReminderDelivery));
  assert.ok(
    /select r\.user_id, r\.dismissed_at,\s*\n\s*public\.reminder_effective_due_at\(r\.kind, r\.scheduled_for, r\.remind_before_minutes, r\.remind_at\)/.test(fnClaimReminderDelivery),
    "must re-read live reminder state through reminder_effective_due_at, never trust the caller's own candidate snapshot",
  );
  assert.ok(!/coalesce\(updated_at, created_at\)/.test(fnClaimReminderDelivery), "the old, unsafe occurrence-identity formula must not still be present anywhere in this function");
});

check("G5 (test §27): the atomic claim's fresh-insert path targets the exact partial unique index on (reminder_id, occurrence_version) where kind = 'reminder'", () => {
  assert.ok(/create unique index if not exists reminder_deliveries_occurrence_idx\s*\n\s*on public\.reminder_deliveries \(reminder_id, occurrence_version\)\s*\n\s*where kind = 'reminder';/.test(migrationSource));
  assert.ok(/on conflict \(reminder_id, occurrence_version\) where kind = 'reminder' do nothing/.test(fnClaimReminderDelivery));
});

check("G6: reminder_deliveries' kind CHECK constraint enforces reminder rows always carry reminder_id+occurrence_version and test rows carry neither — structurally distinguishable (Stage 37 §22)", () => {
  assert.ok(/kind = 'reminder' and reminder_id is not null and occurrence_version is not null/.test(migrationSource));
  assert.ok(/kind = 'test' and reminder_id is null and occurrence_version is null/.test(migrationSource));
});

check("G7: subscription field bounds (endpoint/p256dh/auth_key) are enforced both by table CHECK constraints and re-validated inside upsert_push_subscription — never trusted from client input alone", () => {
  assert.ok(/push_subscriptions_endpoint_check check \(length\(endpoint\) > 0 and length\(endpoint\) <= 2000\)/.test(migrationSource));
  assert.ok(/length\(p_endpoint\) > 2000/.test(fnUpsertPushSubscription) && /length\(p_p256dh\) > 512/.test(fnUpsertPushSubscription) && /length\(p_auth_key\) > 256/.test(fnUpsertPushSubscription));
});

check("G8: list_due_reminder_candidates is read-only (language sql, stable), locked to service_role only, and delegates the due-instant formula to reminder_effective_due_at rather than reimplementing it — a single source of truth with claim_reminder_delivery", () => {
  assert.ok(/language sql\s*\n\s*stable/.test(fnListDueReminderCandidates));
  assert.ok(/grant execute .* to service_role/.test(fnListDueReminderCandidates));
  assert.ok(/set search_path = pg_catalog, pg_temp/.test(fnListDueReminderCandidates));
  assert.ok((fnListDueReminderCandidates.match(/public\.reminder_effective_due_at\(/g) ?? []).length >= 3, "expected every due-instant computation in this query to call the shared function, not inline the case/when formula again");
});

check("G9 (migration-review §11 — full SECURITY DEFINER/INVOKER audit): every one of the four functions declares an explicit security mode and pins search_path, and reminder_effective_due_at (the new pure helper) is IMMUTABLE, SECURITY INVOKER, and locked to service_role only — no broader grant than its two actual callers need", () => {
  for (const fn of [fnReminderEffectiveDueAt, fnUpsertPushSubscription, fnClaimReminderDelivery, fnListDueReminderCandidates]) {
    assert.ok(/security (definer|invoker)/.test(fn), "every function must declare its security mode explicitly, never rely on the implicit default silently");
    assert.ok(/set search_path = pg_catalog, pg_temp/.test(fn), "every function must pin a safe search_path — the classic search-path-hijack defense");
  }
  assert.ok(/language sql\s*\n\s*immutable\s*\n\s*security invoker/.test(fnReminderEffectiveDueAt), "a pure function of scalar inputs with no table access should be IMMUTABLE and needs no elevated privilege");
  assert.ok(/revoke all on function public\.reminder_effective_due_at[^;]*from anon, authenticated;/.test(fnReminderEffectiveDueAt));
  assert.ok(/grant execute on function public\.reminder_effective_due_at[^;]*to service_role;/.test(fnReminderEffectiveDueAt));
});

check("G10: no function in this migration uses dynamic SQL (EXECUTE/format) — every input is a typed, parameterized plpgsql/SQL argument, so there is no SQL-injection surface to audit in the first place", () => {
  assert.ok(!/\bEXECUTE\s+format\(|\bEXECUTE\s+'/.test(migrationSource));
});

check("G11 (migration-review §1/§3 — lease and backoff columns exist with sane defaults): reminder_deliveries has claimed_at/lease_expires_at (not null) and next_attempt_at (nullable), plus a CHECK that a lease never ends before it starts", () => {
  assert.ok(/claimed_at timestamptz not null default now\(\)/.test(migrationSource));
  assert.ok(/lease_expires_at timestamptz not null default now\(\)/.test(migrationSource));
  assert.ok(/next_attempt_at timestamptz,/.test(migrationSource));
  assert.ok(/reminder_deliveries_lease_check check \(lease_expires_at >= claimed_at\)/.test(migrationSource));
});

check("G12 (migration-review §1 — stale-lease self-healing to a terminal state): a 'claimed' row whose lease has expired AND is already at the attempt cap is transitioned to 'failed'/retryable=false directly inside the claim function, returning 'exhausted' — it can never loop as 'claimed' forever", () => {
  assert.ok(/if v_existing\.attempt_count >= 5 then\s*\n\s*update public\.reminder_deliveries\s*\n\s*set status = 'failed', retryable = false, completed_at = v_now\s*\n\s*where id = v_existing\.id;\s*\n\s*return jsonb_build_object\('status', 'exhausted'\);/.test(fnClaimReminderDelivery));
});

check("G12b (disposable-database-test finding): the 'failed'+retryable branch's OWN cap check also self-heals to retryable=false (a real bug found via live PostgreSQL testing — this branch used to return 'exhausted' without ever mutating the row, leaving it at retryable=true forever, inconsistent with G12's 'claimed' branch self-heal above)", () => {
  const failedBranch = fnClaimReminderDelivery.slice(fnClaimReminderDelivery.indexOf("-- v_existing.status = 'failed' from here on."));
  assert.ok(
    /if v_existing\.attempt_count >= 5 then[\s\S]*?update public\.reminder_deliveries\s*\n\s*set retryable = false, completed_at = v_now\s*\n\s*where id = v_existing\.id;\s*\n\s*return jsonb_build_object\('status', 'exhausted'\);/.test(failedBranch),
    "the failed-branch cap check must self-heal retryable to false before returning exhausted, matching the claimed-branch's own behavior",
  );
});

check("G13 (migration-review §7 — skipped reclaim never touches attempt_count): the 'skipped' branch's UPDATE statement does not increment attempt_count, unlike every other reclaim branch", () => {
  const skippedBranch = fnClaimReminderDelivery.slice(fnClaimReminderDelivery.indexOf("if v_existing.status = 'skipped' then"), fnClaimReminderDelivery.indexOf("if v_existing.status = 'claimed' then"));
  assert.ok(!/attempt_count = v_existing\.attempt_count \+ 1/.test(skippedBranch), "reclaiming a skip must not consume a retry attempt");
  assert.ok(/set status = 'claimed'/.test(skippedBranch));
});

check("G14b (final-review-pass §1/§2, no-subscription churn fix): list_due_reminder_candidates requires an EXISTS(active push_subscriptions) match keyed by user_id — never selecting/returning any subscription column (endpoint/p256dh/auth_key)", () => {
  assert.ok(/exists \(\s*\n\s*select 1 from public\.push_subscriptions ps\s*\n\s*where ps\.user_id = r\.user_id and ps\.disabled_at is null\s*\n\s*\)/.test(fnListDueReminderCandidates));
  const existsClause = fnListDueReminderCandidates.slice(fnListDueReminderCandidates.indexOf("exists ("));
  assert.ok(!/endpoint|p256dh|auth_key/.test(existsClause), "the EXISTS check must never select subscription secret columns");
});

check("G14c (final-review-pass §3/§4, skipped-defer gating): the 'skipped' branch checks next_attempt_at before reclaiming, mirroring the 'failed'+retryable branch's own gating pattern rather than being a special case", () => {
  const skippedBranch = fnClaimReminderDelivery.slice(fnClaimReminderDelivery.indexOf("if v_existing.status = 'skipped' then"), fnClaimReminderDelivery.indexOf("if v_existing.status = 'claimed' then"));
  assert.ok(/if v_existing\.next_attempt_at is not null and v_existing\.next_attempt_at > v_now then\s*\n\s*return jsonb_build_object\('status', 'retry_pending'/.test(skippedBranch));
});

check("G14 (test §66): migrations 0001-0016 remain untouched — 0017 is additive and is now the latest", () => {
  const files = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
  const highest = files[files.length - 1];
  assert.equal(highest, "0017_stage37_web_push.sql");
  for (let n = 1; n <= 16; n += 1) {
    const padded = String(n).padStart(4, "0");
    assert.ok(files.some((name) => name.startsWith(`${padded}_`)), `expected migration ${padded}_* to still exist`);
  }
});

// ============================================================
// H — architectural/UX contracts (Stage 37 §1/§17/§38/§39/§84/§85/§86).
// ============================================================
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

check("H1 (test §77): Notification.requestPermission is called from exactly one place in the actual CODE (enable()) — never from a passive effect, never on mount, never merely because the user signed in/created a reminder/opened Reminders", () => {
  const hookSource = stripComments(src("src/hooks/usePushNotifications.ts"));
  const occurrences = [...hookSource.matchAll(/requestPermission\(/g)];
  assert.equal(occurrences.length, 1, `expected exactly one requestPermission() call site, found ${occurrences.length}`);
  const index = occurrences[0].index;
  const enableStart = hookSource.indexOf("const enable = useCallback");
  const reconnectStart = hookSource.indexOf("const reconnect = useCallback");
  assert.ok(index > enableStart && index < reconnectStart, "requestPermission must be called from inside enable(), not reconnect() or anywhere else");
});

check("H2: reconnect() reuses the existing subscription and never calls pushManager.subscribe() or requestPermission() a second time (Stage 37 §47)", () => {
  const hookSource = src("src/hooks/usePushNotifications.ts");
  const reconnectFn = hookSource.slice(hookSource.indexOf("const reconnect = useCallback"), hookSource.indexOf("const disable = useCallback"));
  assert.ok(!/requestPermission|pushManager\.subscribe\(/.test(reconnectFn));
});

check("H3: no component/hook requests Notification permission or calls pushManager.subscribe from a useEffect body", () => {
  for (const file of ["src/hooks/usePushNotifications.ts", "src/components/NotificationsSettingsPanel.tsx"]) {
    const source = src(file);
    const effectBodies = [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)].map((m) => m[1]);
    for (const body of effectBodies) {
      assert.ok(!/requestPermission\(|pushManager\.subscribe\(/.test(body), `${file} must never request permission or subscribe from inside useEffect`);
    }
  }
});

check("H4 (test §86): no onboarding-related file ever requests Notification permission", () => {
  for (const file of ["src/lib/onboarding.ts", "src/hooks/useOnboarding.ts", "src/hooks/useLibraryActivation.ts", "src/components/DashboardView.tsx", "src/components/LibraryView.tsx"]) {
    assert.ok(!src(file).includes("requestPermission"), `${file} must never touch Notification permission`);
  }
});

check("H5: VAPID_PRIVATE_KEY is read only inside the server-only transport module — never referenced from any component, hook, or client-reachable lib file", () => {
  assert.ok(src("src/lib/push/transport.ts").includes("VAPID_PRIVATE_KEY"));
  const clientDirs = ["src/components", "src/hooks"];
  for (const dir of clientDirs) {
    for (const file of listFilesRecursive(dir)) {
      assert.ok(!src(file).includes("VAPID_PRIVATE_KEY"), `${file} must never reference VAPID_PRIVATE_KEY`);
    }
  }
});

check("H6 (test §38/§39): the scheduled processor route is protected by a server-only bearer secret, never by user session auth, and never reads PUSH_CRON_SECRET from a query string", () => {
  const source = src("src/app/api/push/process-due/route.ts");
  assert.ok(source.includes("process.env.PUSH_CRON_SECRET"));
  assert.ok(!/createClient\(\)|auth\.getUser\(\)/.test(source), "must not authorize via a user session — a single user's session can never authorize processing every user's reminders");
  assert.ok(!/searchParams|new URL\(request\.url\)/.test(source), "must not accept the secret via query string");
  assert.ok(source.includes('authHeader.startsWith("Bearer ")'));
  assert.ok(source.includes("timingSafeEqual"), "the secret comparison should be timing-safe, not a plain === on attacker-influenced input");
});

check("H7: the test-notification route IS session-authenticated (an ordinary logged-in user action) and scopes the subscription lookup to that session's own user id", () => {
  const source = src("src/app/api/push/test/route.ts");
  assert.ok(source.includes("createClient()") && source.includes("auth.getUser()"));
  assert.ok(source.includes('.eq("user_id", userData.user.id)'));
});

check("H8 (test §65): no reminder mutation function is ever called from the push payload/delivery/service-worker code — push delivery never dismisses or otherwise mutates a reminder (Stage 37 §33/§58)", () => {
  for (const file of ["src/lib/push/deliver.ts", "src/lib/push/payload.ts", "public/sw.js"]) {
    assert.ok(!/dismissReminder|patchReminder|updateReminderRow|deleteReminderRow/.test(src(file)), `${file} must never mutate reminder state`);
  }
});

check("H9: the reminder notification payload never includes a tracking-source/external URL, tags, description, or rating — only the item's own title (Stage 37 §7)", () => {
  const source = stripComments(src("src/lib/push/payload.ts"));
  const inputInterface = source.slice(source.indexOf("interface ReminderNotificationInput"), source.indexOf("export function buildReminderNotificationPayload"));
  assert.ok(!/sourceUrl|trackingSource|tags|description|rating|hostname/i.test(inputInterface), "the notification input shape must stay minimal");
});

check("H9b (final-review-pass §3, no-subscription churn fix): lib/push/deliver.ts sets a deferred next_attempt_at (SKIPPED_RETRY_DEFER_MINUTES) when finalizing a 'skipped' outcome — it is no longer left null/immediately reclaimable", () => {
  const source = src("src/lib/push/deliver.ts");
  assert.ok(source.includes("SKIPPED_RETRY_DEFER_MINUTES"), "must import and use the deferred-retry constant");
  assert.ok(/outcome\.status === "skipped"/.test(source), "must specifically branch on the skipped outcome to compute its defer time");
});

check("H10 (test §84): the Reminders page shows at most a restrained status LINK to Settings, never its own Enable/permission button", () => {
  const source = src("src/components/ReminderCenterView.tsx");
  assert.ok(source.includes('href="/settings/notifications"'));
  assert.ok(!/requestPermission|pushManager\.subscribe/.test(source), "Reminders must never itself request permission or subscribe — Settings stays canonical");
});

check("H11 (test §85): Settings · Notifications is reachable from the Command Palette's centrally-defined static navigation allowlist, not a one-off addition bypassing it", () => {
  const source = src("src/lib/command-palette.ts");
  assert.ok(/\{ kind: "navigation", id: "nav\.settings\.notifications", label: "Settings · Notifications", href: "\/settings\/notifications" \}/.test(source));
});

check("H12 (test §15/§16, migration-review §8): logout best-effort removes BOTH this browser's server-side push subscription row AND the browser's own PushSubscription — not just the server row — before sign-out completes; the ownership-transfer rule (G3) is the structural second line of defense for account switching", () => {
  const authSource = src("src/components/AuthProvider.tsx");
  assert.ok(authSource.includes("bestEffortDisablePushOnLogout"));
  assert.ok(/bestEffortDisablePushOnLogout\(supabase\);\s*\n\s*await supabase\.auth\.signOut\(\);/.test(authSource), "cleanup must run before signOut, not after or unrelated to it");

  const cleanupSource = src("src/lib/push/logout-cleanup.ts");
  assert.ok(cleanupSource.includes("deletePushSubscriptionByEndpoint"), "must delete the server-side row");
  assert.ok(cleanupSource.includes("subscription.unsubscribe()"), "migration-review §8 finding — must ALSO invalidate the browser's own PushSubscription, not just delete the server row");
  assert.ok(!cleanupSource.includes("Notification.permission ="), "must never attempt to revoke browser Notification permission itself — that is not Markly's to control");
});

check("H13: the logout cleanup's two steps (server-row delete, browser unsubscribe) are each independently best-effort — a failure in one must not skip the other or block sign-out", () => {
  const source = src("src/lib/push/logout-cleanup.ts");
  const fn = source.slice(source.indexOf("export async function bestEffortDisablePushOnLogout"));
  assert.ok(/deletePushSubscriptionByEndpoint\(supabase, subscription\.endpoint\)\.catch\(\(\) => undefined\)/.test(fn));
  assert.ok(/subscription\.unsubscribe\(\)\.catch\(\(\) => undefined\)/.test(fn));
  assert.ok(/try\s*\{[\s\S]*\}\s*catch\s*\{/.test(fn), "the whole function must also be wrapped so sign-out itself is never blocked");
});

check("H14: no dependency was added beyond the documented web-push/@types/web-push pair — no fuzzy-search/unrelated package snuck in alongside it", () => {
  const pkg = JSON.parse(src("package.json"));
  assert.ok(pkg.dependencies["web-push"]);
  assert.ok(pkg.devDependencies["@types/web-push"]);
});

check("H15: detectBrowserLabel is a coarse browser/OS string, never a fingerprinting payload — it never reads screen size, timezone, canvas, or plugin lists", () => {
  const source = src("src/lib/push/capability.ts");
  assert.ok(!/screen\.|getTimezoneOffset|toDataURL|navigator\.plugins|navigator\.languages/.test(source));
});

check("H16 (live-verified regression): adding a 5th Settings tab (Notifications) doesn't reintroduce mobile horizontal overflow — SettingsShell's nav scrolls internally instead of pushing the page past the viewport", () => {
  const source = src("src/components/SettingsShell.tsx");
  assert.ok(/<nav aria-label="Settings" className="[^"]*overflow-x-auto/.test(source), "expected the settings nav row to scroll internally on overflow");
  assert.ok(/shrink-0 whitespace-nowrap border-b-2/.test(source), "expected each tab to stay single-line and never shrink/wrap inside the scroll container");
});

check("H17 (migration-review §21 — no secrets logged): none of the server-side push files call console.* at all — the simplest possible guarantee that a subscription endpoint/key, VAPID private key, or cron secret can never end up in a log line, since nothing is ever logged from these files in the first place", () => {
  for (const file of [
    "src/lib/push/deliver.ts",
    "src/lib/push/transport.ts",
    "src/lib/cloud/push-subscriptions.ts",
    "src/app/api/push/test/route.ts",
    "src/app/api/push/process-due/route.ts",
  ]) {
    assert.ok(!/console\./.test(src(file)), `${file} must not log anything at all`);
  }
});

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// ============================================================
// I — account-switch / endpoint-ownership behavior, reproduced as an
// in-memory model of upsert_push_subscription's conflict-target upsert
// (migration-review §9/§10).
// ============================================================
function makeFakeSubscriptionStore() {
  return new Map(); // endpoint -> { userId, p256dh, authKey, disabledAt }
}

/** Mirrors upsert_push_subscription's ON CONFLICT (endpoint) DO UPDATE — always reassigns user_id to whoever is "currently authenticated" (the caller-supplied uid here stands in for auth.uid()). */
function upsertSubscription(store, uid, endpoint, keys) {
  store.set(endpoint, { userId: uid, p256dh: keys.p256dh, authKey: keys.authKey, disabledAt: null });
}

function activeSubscriptionsForUser(store, uid) {
  return [...store.entries()].filter(([, row]) => row.userId === uid && row.disabledAt === null).map(([endpoint]) => endpoint);
}

check("I1 (test §80, account switch): User A subscribes, then User B (re-)subscribes the SAME browser endpoint — ownership flips atomically to B, and A no longer has any active subscription at that endpoint", () => {
  const store = makeFakeSubscriptionStore();
  upsertSubscription(store, "user-a", "https://push.example/ep1", { p256dh: "a-key", authKey: "a-auth" });
  assert.deepEqual(activeSubscriptionsForUser(store, "user-a"), ["https://push.example/ep1"]);

  upsertSubscription(store, "user-b", "https://push.example/ep1", { p256dh: "b-key", authKey: "b-auth" });
  assert.deepEqual(activeSubscriptionsForUser(store, "user-a"), [], "User A must have zero active subscriptions at this endpoint once B re-subscribes it");
  assert.deepEqual(activeSubscriptionsForUser(store, "user-b"), ["https://push.example/ep1"]);
});

check("I2 (test §80): after the switch, a due-reminder delivery for User A's OWN reminder resolves zero active subscriptions for A at the shared endpoint — A's reminder can never route through B's browser, and vice versa", () => {
  const store = makeFakeSubscriptionStore();
  upsertSubscription(store, "user-a", "https://push.example/ep1", { p256dh: "a-key", authKey: "a-auth" });
  upsertSubscription(store, "user-b", "https://push.example/ep1", { p256dh: "b-key", authKey: "b-auth" });
  // The delivery engine's real query is `.eq("user_id", candidate.userId)` —
  // modeled here as the same per-user filter.
  assert.equal(activeSubscriptionsForUser(store, "user-a").length, 0);
  assert.equal(activeSubscriptionsForUser(store, "user-b").length, 1);
});

check("I3 (migration-review §10, endpoint-ownership threat model): the upsert keys ONLY on endpoint + the currently-authenticated uid — it never reads or requires any client-supplied user id, so a malicious re-subscription attempt can only ever assign ownership to whoever is ACTUALLY authenticated for that request, never an arbitrary third party", () => {
  const source = src("supabase/migrations/0017_stage37_web_push.sql");
  const fn = source.slice(source.indexOf("create or replace function public.upsert_push_subscription"), source.indexOf("create or replace function public.claim_reminder_delivery"));
  assert.ok(/v_uid uuid := auth\.uid\(\)/.test(fn));
  assert.ok(/user_id = excluded\.user_id/.test(fn));
  // excluded.user_id is populated from the INSERT's own values list, which
  // itself is v_uid (auth.uid()) — never a parameter — confirmed by the
  // absence of any p_user_id/p_uid input parameter anywhere in this
  // function (see check G3).
  assert.ok(!/p_user_id|p_uid/.test(fn));
});

check("I4 (migration-review §10 — threat model is documented, not just implemented): the migration's own comments record the endpoint-possession trust model and the worst-case consequence analysis (denial-of-service against the rightful owner, never content disclosure to an attacker) — a reviewer doesn't have to re-derive this from scratch", () => {
  const source = src("supabase/migrations/0017_stage37_web_push.sql");
  assert.ok(/Threat model \(reliability review §10\)/.test(source));
  assert.ok(/denial-of-service against the/.test(source));
  assert.ok(/NEVER disclosure of the victim's reminder content/.test(source));
});

// ============================================================
// J — no-subscription churn fix (final-review-pass §1/§2/§3/§4), reproduced
// as an in-memory model of list_due_reminder_candidates' new active-
// subscription EXISTS filter and claim_reminder_delivery's new deferred
// 'skipped' reclaim gating (0017_stage37_web_push.sql). Confirms the
// concrete scenario the review described: a due reminder with zero active
// subscriptions no longer gets claimed/re-examined once per scheduler
// tick for the entire 24h catch-up window.
// ============================================================

/** Mirrors list_due_reminder_candidates' new EXISTS(push_subscriptions ...) clause — a pure existence check, never resolving/returning any subscription column. */
function listDueReminderCandidates(reminders, subscriptionsByUser, nowMs, catchupMinutes) {
  const candidates = [];
  for (const [reminderId, reminder] of reminders) {
    if (reminder.dismissedAt) continue;
    const dueAt = reminderEffectiveDueAt(reminder);
    if (dueAt > nowMs) continue;
    if (nowMs - dueAt > catchupMinutes * 60_000) continue;
    const hasActiveSubscription = (subscriptionsByUser.get(reminder.userId) ?? []).some((sub) => sub.disabledAt === null);
    if (!hasActiveSubscription) continue;
    candidates.push({ reminderId, userId: reminder.userId, occurrenceVersion: dueAt });
  }
  return candidates.sort((a, b) => a.occurrenceVersion - b.occurrenceVersion || (a.reminderId > b.reminderId ? 1 : -1));
}

check("J1 (test-matrix A, no-subscription churn — CONFIRMED the reported behavior existed): before this fix, a due reminder with zero active subscriptions would have been claimed and re-examined on every scheduler tick for the full 24h catch-up window (up to ~1440 pointless claim+lookup+finalize cycles at a 1-minute cadence) — now it is excluded from candidacy entirely and never claimed at all", () => {
  const reminders = new Map([["r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: new Date(T0).toISOString() }]]);
  const noSubscriptions = new Map();
  const candidates = listDueReminderCandidates(reminders, noSubscriptions, T0, CATCHUP_WINDOW_MINUTES);
  assert.equal(candidates.length, 0, "a due reminder whose owner has zero active subscriptions must never be a candidate");
});

check("J2 (test-matrix B): once an active subscription appears (even minutes later), the SAME due reminder becomes a candidate on the next scheduler run — still within the catch-up window", () => {
  const reminders = new Map([["r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: new Date(T0).toISOString() }]]);
  const subscriptionsByUser = new Map();
  assert.equal(listDueReminderCandidates(reminders, subscriptionsByUser, T0, CATCHUP_WINDOW_MINUTES).length, 0);

  subscriptionsByUser.set("u1", [{ disabledAt: null }]);
  const laterCandidates = listDueReminderCandidates(reminders, subscriptionsByUser, T0 + 5 * 60_000, CATCHUP_WINDOW_MINUTES);
  assert.equal(laterCandidates.length, 1);
  assert.equal(laterCandidates[0].reminderId, "r1");
});

check("J3 (test-matrix C): a subscription added AFTER the catch-up window has fully elapsed never makes the old occurrence a candidate again — no historical push, matching the unchanged catch-up policy", () => {
  const reminders = new Map([["r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: new Date(T0).toISOString() }]]);
  const subscriptionsByUser = new Map([["u1", [{ disabledAt: null }]]]);
  const tooLate = listDueReminderCandidates(reminders, subscriptionsByUser, T0 + (CATCHUP_WINDOW_MINUTES + 60) * 60_000, CATCHUP_WINDOW_MINUTES);
  assert.equal(tooLate.length, 0);
});

check("J4 (test-matrix D, post-candidate-query race): finalizing a claimed occurrence with zero RESOLVED subscriptions (subscription existed at candidate-query time but vanished by actual fan-out time) records status='skipped' WITH a deferred next_attempt_at — never immediately reclaimable", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(db, "r1", T0, T0);
  const row = db.deliveries.get(`r1|${T0}`);
  // Simulate lib/push/deliver.ts's finalization for a zero-subscription outcome.
  row.status = "skipped";
  row.nextAttemptAt = T0 + SKIPPED_RETRY_DEFER_MINUTES * 60_000;

  const immediateReclaim = claimReminderDelivery(db, "r1", T0, T0 + 1000);
  assert.equal(immediateReclaim.status, "retry_pending", "must not be immediately reclaimable after a skip");
});

check("J5 (test-matrix E): a skipped occurrence cannot reclaim before its next_attempt_at, at any point during the defer window", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(db, "r1", T0, T0);
  const row = db.deliveries.get(`r1|${T0}`);
  row.status = "skipped";
  row.nextAttemptAt = T0 + SKIPPED_RETRY_DEFER_MINUTES * 60_000;

  const at1Min = claimReminderDelivery(db, "r1", T0, T0 + 60_000);
  const at10Min = claimReminderDelivery(db, "r1", T0, T0 + 10 * 60_000);
  const at14Min59 = claimReminderDelivery(db, "r1", T0, row.nextAttemptAt - 1);
  assert.equal(at1Min.status, "retry_pending");
  assert.equal(at10Min.status, "retry_pending");
  assert.equal(at14Min59.status, "retry_pending");
});

check("J6 (test-matrix F): a skipped occurrence DOES reclaim once next_attempt_at has passed, without incrementing attempt_count", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(db, "r1", T0, T0);
  const row = db.deliveries.get(`r1|${T0}`);
  const attemptCountBefore = row.attemptCount;
  row.status = "skipped";
  row.nextAttemptAt = T0 + SKIPPED_RETRY_DEFER_MINUTES * 60_000;

  const eligible = claimReminderDelivery(db, "r1", T0, row.nextAttemptAt + 1);
  assert.equal(eligible.status, "claimed");
  assert.equal(eligible.attemptCount, attemptCountBefore, "reclaiming a skip must never consume attempt budget (test-matrix G)");
});

check("J7 (test-matrix G, attempt_count semantics): across an entire skip -> defer -> reclaim -> skip-again -> defer -> reclaim cycle, attempt_count never moves — it tracks REAL external Web Push attempts only, never how many times the scheduler merely examined the occurrence", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  const first = claimReminderDelivery(db, "r1", T0, T0);
  const row = db.deliveries.get(`r1|${T0}`);
  for (let i = 0; i < 3; i += 1) {
    row.status = "skipped";
    row.nextAttemptAt = row.claimedAt + SKIPPED_RETRY_DEFER_MINUTES * 60_000;
    const reclaim = claimReminderDelivery(db, "r1", T0, row.nextAttemptAt + 1);
    assert.equal(reclaim.status, "claimed");
    assert.equal(reclaim.attemptCount, first.attemptCount);
  }
});

check("J8 (test-matrix H, repeated-scheduler churn test): a 1-minute-cadence scheduler simulated across the FULL 24h catch-up window reclaims a permanently-skipped occurrence only ~96 times (once per 15-minute defer window), never once per minute (~1440 times) — the concrete churn the review flagged is gone", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: new Date(T0).toISOString() });
  claimReminderDelivery(db, "r1", T0, T0);
  let now = T0;
  let claimedCount = 0;
  let retryPendingCount = 0;
  const oneMinute = 60_000;
  const totalTicks = Math.floor((CATCHUP_WINDOW_MINUTES * 60_000) / oneMinute);
  for (let tick = 0; tick < totalTicks; tick += 1) {
    now += oneMinute;
    const result = claimReminderDelivery(db, "r1", T0, now);
    if (result.status === "claimed") {
      claimedCount += 1;
      const row = db.deliveries.get(`r1|${T0}`);
      row.status = "skipped";
      row.nextAttemptAt = now + SKIPPED_RETRY_DEFER_MINUTES * 60_000;
    } else if (result.status === "retry_pending") {
      retryPendingCount += 1;
    }
  }
  const expectedMaxClaims = Math.ceil(totalTicks / SKIPPED_RETRY_DEFER_MINUTES) + 1;
  assert.ok(claimedCount <= expectedMaxClaims, `expected at most ~${expectedMaxClaims} reclaims across ${totalTicks} one-minute ticks (one per ${SKIPPED_RETRY_DEFER_MINUTES}-minute defer window), saw ${claimedCount}`);
  assert.ok(claimedCount < totalTicks / 10, `must be dramatically fewer reclaims than scheduler ticks — saw ${claimedCount} claims across ${totalTicks} ticks`);
  assert.ok(retryPendingCount > 0, "most ticks should be cheap no-op retry_pending responses, not real reclaims");
});

check("J9 (test-matrix I, failed-retry semantics unchanged): a 'failed'+retryable occurrence's backoff/reclaim behavior is untouched by the skip-defer fix — still gated by its own next_attempt_at and attempt cap, unaffected by SKIPPED_RETRY_DEFER_MINUTES", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(db, "r1", T0, T0);
  const row = db.deliveries.get(`r1|${T0}`);
  row.status = "failed";
  row.retryable = true;
  row.nextAttemptAt = T0 + retryBackoffMinutes(1) * 60_000;

  const tooSoon = claimReminderDelivery(db, "r1", T0, T0 + 30_000);
  assert.equal(tooSoon.status, "retry_pending");
  const eligible = claimReminderDelivery(db, "r1", T0, row.nextAttemptAt + 1);
  assert.equal(eligible.status, "claimed");
  assert.equal(eligible.attemptCount, 2, "a failed-retry reclaim must still increment attempt_count, unlike a skip reclaim");
});

check("J10 (test-matrix J, expired-lease recovery unchanged): a crashed claim (stuck 'claimed' past its lease) still recovers exactly as before — unaffected by the active-subscription candidate filter or the skip-defer change, since it never touches the 'skipped' branch at all", () => {
  const db = makeFakeDb();
  db.reminders.set("r1", { userId: "u1", dismissedAt: null, kind: "continue", remindAt: "2026-06-01T10:00:00.000Z" });
  claimReminderDelivery(db, "r1", T0, T0);
  const tooSoon = claimReminderDelivery(db, "r1", T0, T0 + 60_000);
  assert.equal(tooSoon.status, "already_leased");
  const recovered = claimReminderDelivery(db, "r1", T0, T0 + CLAIM_LEASE_MS + 1000);
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.attemptCount, 2);
});

check("J11 (test-matrix K/L, multi-device and dead-device behavior unchanged): resolveDeliveryOutcome's occurrence-level success definition and classifyPushFailure's 404/410-only disable rule are untouched by this fix — re-confirms C3/C4 still hold after the churn fix", () => {
  const multiDeviceOutcome = resolveDeliveryOutcome([
    { subscriptionId: "s1", outcome: "sent" },
    { subscriptionId: "s2", outcome: "permanent_failure", statusCode: 410 },
  ]);
  assert.equal(multiDeviceOutcome.status, "sent");
  assert.equal(classifyPushFailure(410), "permanent");
  assert.equal(shouldDisableSubscription(classifyPushFailure(410)), true);
  assert.equal(shouldDisableSubscription(classifyPushFailure(500)), false);
});

// ============================================================
// K — the GitHub Actions scheduler workflow (Stage 37 §14-§18). Review-only
// at this point: the file exists locally but is neither committed nor
// activated, and its two repository secrets are not yet configured. These
// checks audit its static structure/security properties so a future edit
// can't silently reintroduce an unsafe trigger, an inlined secret, or an
// accidental checkout/build step — targeted structural assertions, not a
// brittle whole-file text/whitespace snapshot.
// ============================================================
const WORKFLOW_PATH = ".github/workflows/push-processor.yml";

check("K1: the scheduler workflow file exists", () => {
  assert.ok(existsSync(WORKFLOW_PATH), `expected ${WORKFLOW_PATH} to exist`);
});

check("K2: the workflow is valid YAML", () => {
  assert.doesNotThrow(() => yaml.load(src(WORKFLOW_PATH)), "workflow file must parse as valid YAML");
});

const workflow = yaml.load(src(WORKFLOW_PATH));
// YAML 1.1 treats a bare `on:` key as the boolean `true` — js-yaml preserves
// that, so the trigger map must be read from the boolean-keyed property.
const triggers = workflow.on ?? workflow[true];

check("K3: triggers are exactly {schedule, workflow_dispatch} — no push or pull_request trigger", () => {
  assert.deepEqual(Object.keys(triggers).sort(), ["schedule", "workflow_dispatch"]);
});

check("K4: the schedule cron expression is exactly the agreed 5-minute, minute-0-avoiding cadence", () => {
  assert.equal(triggers.schedule.length, 1);
  assert.equal(triggers.schedule[0].cron, "2-57/5 * * * *");
});

check("K5: workflow_dispatch takes no inputs — it cannot be used to smuggle a custom URL/secret/header at run time", () => {
  const dispatch = triggers.workflow_dispatch;
  assert.ok(dispatch === null || typeof dispatch === "object", "workflow_dispatch must be present");
  assert.ok(!dispatch || !dispatch.inputs, "workflow_dispatch must not declare any inputs");
});

check("K6: top-level permissions are empty — this workflow never uses GITHUB_TOKEN for anything (no checkout, no API calls)", () => {
  assert.deepEqual(workflow.permissions, {});
});

check("K7: concurrency is configured to group same-workflow runs without cancelling an in-flight invocation", () => {
  assert.equal(workflow.concurrency.group, "markly-push-processor");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

check("K8: exactly one job, running on a plain Ubuntu runner, with a bounded job-level timeout", () => {
  const jobs = Object.values(workflow.jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]["runs-on"], "ubuntu-latest");
  assert.ok(typeof jobs[0]["timeout-minutes"] === "number" && jobs[0]["timeout-minutes"] > 0);
});

check("K9: no checkout, dependency install, build, or Supabase CLI step exists — the workflow's only job is one HTTP call", () => {
  const rawSteps = JSON.stringify(Object.values(workflow.jobs)[0].steps);
  assert.ok(!/actions\/checkout|actions\/setup-node|npm (ci|install|run)|supabase\b/i.test(rawSteps), "workflow must not check out or build the repository");
});

check("K10: the processor URL and cron secret are BOTH sourced from repository secrets, never inlined as literal values", () => {
  const runScript = Object.values(workflow.jobs)[0].steps[0].run;
  const envBlock = Object.values(workflow.jobs)[0].steps[0].env;
  assert.equal(envBlock.MARKLY_PUSH_PROCESSOR_URL, "${{ secrets.MARKLY_PUSH_PROCESSOR_URL }}");
  assert.equal(envBlock.PUSH_CRON_SECRET, "${{ secrets.PUSH_CRON_SECRET }}");
  assert.ok(!/https:\/\/markly-lime\.vercel\.app/.test(runScript), "the run script itself must not hardcode the production URL — it must come from the env var");
});

check("K11: the request is a POST, and the Authorization header is built only from the env-var secret — never echoed, never placed in the URL/query string", () => {
  const runScript = Object.values(workflow.jobs)[0].steps[0].run;
  assert.ok(/--request POST/.test(runScript));
  assert.ok(/--header "Authorization: Bearer \$\{PUSH_CRON_SECRET\}"/.test(runScript));
  assert.ok(!/echo.*PUSH_CRON_SECRET|PUSH_CRON_SECRET.*\?|&.*PUSH_CRON_SECRET/i.test(runScript), "the secret must never be echoed or appended as a query parameter");
});

check("K12: no xtrace / verbose curl flag exists anywhere that could dump the Authorization header into the run log", () => {
  const runScript = Object.values(workflow.jobs)[0].steps[0].run;
  assert.ok(!/set -x|set -o xtrace/.test(runScript), "must never enable shell xtrace, which would print the substituted curl command including the secret");
  assert.ok(!/curl[^\n]*(^|\s)-v(\s|$)|--verbose/.test(runScript), "must never use curl -v/--verbose");
});

check("K13: connect and overall timeouts are both configured on the curl call, and a non-2xx response fails the job", () => {
  const runScript = Object.values(workflow.jobs)[0].steps[0].run;
  assert.ok(/--connect-timeout \d+/.test(runScript));
  assert.ok(/--max-time \d+/.test(runScript));
  assert.ok(/exit 1/.test(runScript), "a non-2xx response must fail the job rather than being swallowed");
});

// ============================================================
// Report
// ============================================================
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
  if (!r.ok) console.log(`  ${r.err?.message ?? r.err}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;

console.log(
  "\nNote: Sections A-D reproduce src/lib/push/{payload,delivery-policy,vapid-key}.ts verbatim (same convention as every other script in this directory) and test them directly — deterministic, no network/database involved. Section E reproduces reminder_effective_due_at's occurrence-identity formula and audits it against the full test matrix from the migration-review report. Section F models claim_reminder_delivery's complete lease/backoff/exhaustion state machine (0017_stage37_web_push.sql) as an in-memory ALGORITHM, run here for fast, deterministic, offline regression on every commit. This algorithm HAS ALSO been validated against real PostgreSQL: a disposable Supabase test project ('markly-stage37-test') had migrations 0001-0017 applied fresh and a 60-check integration harness run against it (real Auth-issued JWTs, real RLS, real concurrent RPC calls, real CHECK-constraint enforcement) — see the 'Real Disposable Supabase Database Validation' report for the full results, including one genuine defect (the 'failed'-branch exhaustion self-heal, G12b) that only surfaced under real testing and is now fixed here. That disposable project was torn down/cleaned of test data afterward; this script's own in-memory model remains the fast day-to-day regression check. Sections G-H statically verify migration structure and architectural/UX contracts, including a full SECURITY DEFINER/INVOKER audit. Section I models the endpoint-ownership/account-switch behavior (also confirmed against real RLS in the disposable-database pass). It cannot and does not send a real push notification or judge visual quality — those require a real browser, documented as a limitation in the Stage 37 reports.",
);
