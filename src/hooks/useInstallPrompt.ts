"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isIOSPlatform, isIOSStandaloneFlag, isStandaloneDisplayMode, resolveInstallState, type InstallState } from "@/lib/pwa/install-state";

/** Not yet in the DOM lib's standard Event types — Chromium-only, still non-standard. */
interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

/**
 * Stage 38 §12/§13 — owns the entire `beforeinstallprompt`/`appinstalled`
 * lifecycle. The deferred event is held only in a ref (never persisted —
 * Stage 38 §12 explicitly forbids that, and it wouldn't survive a reload
 * anyway), and `promptInstall()` is the one function allowed to call
 * `.prompt()` — by construction only ever invoked from an explicit click
 * (see AppSettingsPanel.tsx), never from this hook's own passive effects.
 */
export function useInstallPrompt() {
  const [state, setState] = useState<InstallState>("not-currently-installable");
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);
  const installedThisSessionRef = useRef(false);
  const busyRef = useRef(false);

  const recompute = useCallback(() => {
    if (installedThisSessionRef.current) {
      setState("already-installed");
      return;
    }
    setState(
      resolveInstallState({
        isStandaloneDisplayMode: isStandaloneDisplayMode(),
        isIOSStandaloneFlag: isIOSStandaloneFlag(),
        isIOSPlatform: isIOSPlatform(),
        hasDeferredInstallPrompt: deferredRef.current !== null,
      }),
    );
  }, []);

  useEffect(() => {
    recompute();

    function onBeforeInstallPrompt(event: Event) {
      // Stage 38 §12 — prevented only so Markly's own restrained Settings
      // action is the single install entry point, rather than also showing
      // Chrome's own mini-infobar at the same time.
      event.preventDefault();
      deferredRef.current = event as BeforeInstallPromptEvent;
      recompute();
    }
    function onAppInstalled() {
      // Stage 38 §13 — the event fired for real; mark this for the rest of
      // the session regardless of what display-mode this particular tab
      // reports (the newly installed app is a separate window the user
      // hasn't necessarily switched to yet).
      deferredRef.current = null;
      installedThisSessionRef.current = true;
      recompute();
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    const media = typeof window.matchMedia === "function" ? window.matchMedia("(display-mode: standalone)") : null;
    media?.addEventListener("change", recompute);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      media?.removeEventListener("change", recompute);
    };
  }, [recompute]);

  const promptInstall = useCallback(async () => {
    if (busyRef.current) return;
    const deferred = deferredRef.current;
    if (!deferred) return;
    busyRef.current = true;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } finally {
      // Stage 38 §12 — a captured prompt event can only ever be used once;
      // clear it regardless of the user's choice so a stale reference is
      // never retried.
      deferredRef.current = null;
      busyRef.current = false;
      recompute();
    }
  }, [recompute]);

  return { state, promptInstall };
}
