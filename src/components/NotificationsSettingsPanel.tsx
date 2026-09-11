"use client";

import { usePushNotifications } from "@/hooks/usePushNotifications";
import { Button } from "@/components/Button";

/**
 * Stage 37 §2/§50 — the one Settings destination for background push.
 * Every action here (enable/reconnect/disable/test) is wired directly to
 * an explicit button click via usePushNotifications — nothing in this
 * component or the hook it calls ever requests Notification permission or
 * subscribes on mount/effect. See the hook's own doc comment for the full
 * enable-flow contract.
 */
export function NotificationsSettingsPanel() {
  const { state, testState, enable, disable, reconnect, sendTest } = usePushNotifications();

  return (
    <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">Browser notifications</h2>
        <p className="mt-1 text-sm text-muted-foreground">Receive Markly reminders even when the app isn&rsquo;t open.</p>
      </div>

      <div className="mt-4">
        {state.kind === "checking" && <p className="text-sm text-muted-foreground">Checking this browser&rsquo;s notification status…</p>}

        {state.kind === "not-configured" && (
          <p className="text-sm text-muted-foreground">Background notifications aren&rsquo;t configured for this deployment yet.</p>
        )}

        {state.kind === "unsupported" && (
          <p className="text-sm text-muted-foreground">
            Background notifications aren&rsquo;t supported in this browser. Reminders still work normally inside Markly.
          </p>
        )}

        {state.kind === "blocked" && (
          <p className="text-sm text-muted-foreground">
            Notifications are blocked for Markly in your browser settings. Allow notifications for this site in your browser to enable them here.
          </p>
        )}

        {state.kind === "not-enabled" && (
          <Button variant="primary" onClick={enable}>
            Enable notifications
          </Button>
        )}

        {state.kind === "enabling" && (
          <Button variant="primary" disabled>
            Enabling…
          </Button>
        )}

        {state.kind === "needs-reconnect" && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">This browser was enabled before but needs to reconnect.</p>
            <Button variant="primary" onClick={reconnect}>
              Reconnect
            </Button>
          </div>
        )}

        {state.kind === "enabled" && (
          <div className="space-y-3">
            <p className="text-sm text-foreground">Enabled on this browser</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={sendTest} disabled={testState === "sending"} className="min-w-40">
                {testState === "sending" ? "Sending…" : testState === "sent" ? "Sent!" : testState === "error" ? "Couldn't send" : "Send test notification"}
              </Button>
              <Button variant="ghost" onClick={disable}>
                Disable on this browser
              </Button>
            </div>
          </div>
        )}

        {state.kind === "disabling" && (
          <Button variant="ghost" disabled>
            Disabling…
          </Button>
        )}

        {state.kind === "error" && (
          <div className="space-y-2">
            <p className="text-sm text-danger">{state.message}</p>
            <Button variant="secondary" onClick={enable}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
