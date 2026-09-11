"use client";

import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { Button } from "@/components/Button";

/**
 * Stage 38 §17/§18 — the one Settings destination for installing Markly.
 * Deliberately the only install surface in the product (no Dashboard
 * banner, no first-run popup) — installation is optional and this page is
 * where a user goes looking for it, not something pushed on them.
 */
export function AppSettingsPanel() {
  const { state, promptInstall } = useInstallPrompt();

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">Install Markly</h2>
          <p className="mt-1 text-sm text-muted-foreground">Open Markly like an app, with its own window and icon.</p>
        </div>

        <div className="mt-4">
          {state === "already-installed" && <p className="text-sm text-foreground">Markly is installed on this device.</p>}

          {state === "browser-installable" && (
            <Button variant="primary" onClick={promptInstall}>
              Install Markly
            </Button>
          )}

          {state === "ios-manual-install" && (
            <p className="text-sm text-muted-foreground">
              Open the <span className="font-medium text-foreground">Share</span> menu, then choose{" "}
              <span className="font-medium text-foreground">Add to Home Screen</span>. The exact menu location varies by browser.
            </p>
          )}

          {state === "not-currently-installable" && (
            <p className="text-sm text-muted-foreground">
              This browser isn&rsquo;t currently offering to install Markly. Some browsers show an &ldquo;Install app&rdquo; option in their own menu.
            </p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h3 className="text-sm font-medium text-foreground">About installing</h3>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>Installing doesn&rsquo;t turn on notifications by itself — that&rsquo;s a separate step in Settings → Notifications.</li>
          <li>Installing Markly can also enable browser notifications on supported iPhone and iPad versions, once notifications are turned on there too.</li>
          <li>On supported devices, once Markly is installed you can share links directly to it from your browser or other apps.</li>
        </ul>
      </div>
    </div>
  );
}
