"use client";

import { useEffect, useState } from "react";
import {
  markLibraryActivated,
  persistAutoTrackingNudgeDismissed,
  readOnboardingStorage,
  type OnboardingState,
} from "@/lib/onboarding";

const DEFAULT_STATE: OnboardingState = {
  hasEverHadLibraryItems: false,
  autoTrackingNudgeDismissed: false,
  autoTrackingNudgeEligible: false,
};

/**
 * SSR-safe wrapper around the versioned markly.onboarding localStorage key
 * — same deterministic-default-then-hydrate pattern as useLibraryViewMode
 * (localStorage isn't available at SSR time). Exposes `isHydrated` so a
 * caller folding this into a broader activation-loading gate (see
 * DashboardView) never has to treat "not yet read" the same as "read and
 * confirmed false" for `hasEverHadLibraryItems` — that distinction is
 * exactly what closes the hydration-flash risk for a returning user whose
 * library happens to be empty right now.
 *
 * Most callers should use useLibraryActivation (below) instead of this
 * hook directly — it wraps this one with the page-independent "did this
 * browser just activate for the first time" tracking every first-run
 * surface needs.
 */
export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from localStorage, unavailable at SSR time.
    setState(readOnboardingStorage());
    setIsHydrated(true);
  }, []);

  function dismissAutoTrackingNudge() {
    setState(persistAutoTrackingNudgeDismissed());
  }

  /** See lib/onboarding.ts's markLibraryActivated — call only when itemCount > 0 has actually been observed. */
  function recordLibraryActivated(justCompletedFirstRun: boolean) {
    setState((current) => (current.hasEverHadLibraryItems ? current : markLibraryActivated(justCompletedFirstRun)));
  }

  return {
    isHydrated,
    autoTrackingNudgeDismissed: state.autoTrackingNudgeDismissed,
    hasEverHadLibraryItems: state.hasEverHadLibraryItems,
    autoTrackingNudgeEligible: state.autoTrackingNudgeEligible,
    dismissAutoTrackingNudge,
    recordLibraryActivated,
  };
}
