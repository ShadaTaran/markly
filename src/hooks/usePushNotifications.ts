"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { getSupabaseClient } from "@/lib/supabase/client";
import { detectPushCapability, detectBrowserLabel } from "@/lib/push/capability";
import { urlBase64ToUint8Array } from "@/lib/push/vapid-key";
import { upsertPushSubscription, deletePushSubscriptionByEndpoint, getOwnSubscriptionStatus } from "@/lib/cloud/push-subscriptions";

const SERVICE_WORKER_URL = "/sw.js";

export type PushUiState =
  | { kind: "checking" }
  | { kind: "not-configured" }
  | { kind: "unsupported" }
  | { kind: "blocked" }
  | { kind: "not-enabled" }
  /** Stage 37 §47 — browser already has permission + a live subscription, but the server doesn't recognize it under the CURRENT session (a different account last subscribed this browser, or the row was pruned). Repair is one explicit click away (reconnect()) — never automatic, and never a new permission prompt or a second PushManager.subscribe() call. */
  | { kind: "needs-reconnect" }
  | { kind: "enabled" }
  | { kind: "enabling" }
  | { kind: "disabling" }
  | { kind: "error"; message: string };

export type TestNotificationState = "idle" | "sending" | "sent" | "error";

/**
 * Stage 37 — owns the entire explicit enable/disable/test/reconnect flow
 * (§1/§42) and nothing else: this hook never calls
 * Notification.requestPermission() or PushManager.subscribe() from a
 * passive effect — only from enable()/reconnect(), which by construction
 * are only ever invoked from a click handler (see
 * NotificationsSettingsPanel.tsx). The one thing it DOES do passively, on
 * mount and whenever the signed-in user changes, is read-only capability/
 * permission/subscription detection (§46/§47/§48) — no prompt, no
 * subscribe call, just answering "what state should the Settings page
 * show."
 *
 * Push requires a signed-in (cloud) account: a server delivery engine can
 * only ever see reminders that live in Supabase — a signed-out user's
 * reminders are localStorage-only (see hooks/useReminders.ts) and have no
 * server-observable existence at all. Signed out, this resolves to
 * "not-enabled" rather than "unsupported" (the browser itself may well
 * support push; there's simply nothing for it to subscribe to yet).
 */
export function usePushNotifications() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<PushUiState>({ kind: "checking" });
  const [testState, setTestState] = useState<TestNotificationState>("idle");
  const busyRef = useRef(false);
  const evaluationToken = useRef(0);
  const testToken = useRef(0);

  const evaluate = useCallback(async () => {
    const token = ++evaluationToken.current;
    const publish = (next: PushUiState) => {
      if (evaluationToken.current === token) setState(next);
    };

    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
      publish({ kind: "not-configured" });
      return;
    }
    if (!detectPushCapability()) {
      publish({ kind: "unsupported" });
      return;
    }
    if (Notification.permission === "denied") {
      publish({ kind: "blocked" });
      return;
    }
    if (!userId) {
      publish({ kind: "not-enabled" });
      return;
    }

    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (!subscription) {
        publish({ kind: "not-enabled" });
        return;
      }
      const supabase = getSupabaseClient();
      if (!supabase) {
        publish({ kind: "not-enabled" });
        return;
      }
      const status = await getOwnSubscriptionStatus(supabase, subscription.endpoint);
      publish(status.registered && !status.disabled ? { kind: "enabled" } : { kind: "needs-reconnect" });
    } catch {
      publish({ kind: "not-enabled" });
    }
  }, [userId]);

  useEffect(() => {
    // Read-only detection only (capability + Notification.permission + an
    // already-registered SW's existing subscription, if any) — none of
    // this requests permission or subscribes, so it is not the "silent
    // subscribe" this stage forbids (see the hook's own doc comment).
    // evaluate() sets state asynchronously (inside its own awaits), never
    // synchronously in this effect body, so react-hooks/set-state-in-effect
    // doesn't apply here.
    void evaluate();
  }, [evaluate]);

  async function submitSubscription(subscription: PushSubscription): Promise<PushUiState> {
    const supabase = getSupabaseClient();
    if (!supabase) return { kind: "error", message: "Cloud sync isn't configured for this deployment." };

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { kind: "error", message: "This browser returned an incomplete subscription." };
    }

    const result = await upsertPushSubscription(supabase, {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      authKey: json.keys.auth,
      label: detectBrowserLabel(),
    });
    return result.status === "ok" ? { kind: "enabled" } : { kind: "error", message: "Couldn't save this subscription. Try again." };
  }

  /** Stage 37 §1/§42 — the ONLY function in this hook allowed to request Notification permission or call PushManager.subscribe(); only ever invoked from an explicit click (see the Settings panel). */
  const enable = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState({ kind: "enabling" });
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? { kind: "blocked" } : { kind: "not-enabled" });
        return;
      }

      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
      await navigator.serviceWorker.ready;

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
        if (!publicKey) {
          setState({ kind: "not-configured" });
          return;
        }
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          // The DOM lib's PushSubscriptionOptionsInit type and Uint8Array's
          // own generic ArrayBufferLike parameter don't structurally align
          // in this TypeScript/lib version — the value itself is a real
          // BufferSource at runtime (a plain Uint8Array), so this is a
          // narrow, targeted assertion for a type-declaration mismatch, not
          // a trust-me escape from a real type error.
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
      }

      setState(await submitSubscription(subscription));
    } catch {
      setState({ kind: "error", message: "Couldn't enable notifications. Try again." });
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** Stage 37 §47 — repairs a "needs-reconnect" state by re-sending the browser's EXISTING subscription; never a new permission prompt, never a second PushManager.subscribe() call. */
  const reconnect = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState({ kind: "enabling" });
    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (!subscription) {
        setState({ kind: "not-enabled" });
        return;
      }
      setState(await submitSubscription(subscription));
    } catch {
      setState({ kind: "error", message: "Couldn't reconnect. Try again." });
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** Stage 37 §21/§49 — this browser only; other devices are untouched. Best-effort browser-side unsubscribe: the server row is removed regardless, which is what actually stops delivery (Stage 37 §15's logout policy relies on the same removal). */
  const disable = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState({ kind: "disabling" });
    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      const supabase = getSupabaseClient();
      if (subscription && supabase) {
        await deletePushSubscriptionByEndpoint(supabase, subscription.endpoint).catch(() => undefined);
      }
      if (subscription) await subscription.unsubscribe().catch(() => undefined);
      setState({ kind: "not-enabled" });
    } catch {
      setState({ kind: "error", message: "Couldn't disable notifications. Try again." });
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** Stage 37 §22/§51 — explicit-click only; targets THIS browser's own subscription, never every device. */
  const sendTest = useCallback(async () => {
    const token = ++testToken.current;
    setTestState("sending");
    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (!subscription) {
        if (testToken.current === token) setTestState("error");
        return;
      }
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      if (testToken.current === token) setTestState(response.ok ? "sent" : "error");
    } catch {
      if (testToken.current === token) setTestState("error");
    } finally {
      setTimeout(() => {
        if (testToken.current === token) setTestState("idle");
      }, 4000);
    }
  }, []);

  return { state, testState, enable, disable, reconnect, sendTest };
}
