"use client";

import { useEffect, useRef } from "react";
import { useOnboarding } from "@/hooks/useOnboarding";

interface UseLibraryActivationInput {
  /** Whether the library's real item count is trustworthy yet — the same core loading signal each page already computes (before folding in onboarding's own hydration, which this hook checks separately via useOnboarding's isHydrated). */
  loading: boolean;
  itemCount: number;
}

/**
 * Stage 35 (global consistency fix) — the ONE place hasEverHadLibraryItems/
 * autoTrackingNudgeEligible ever get written, shared by every page that
 * can be someone's first-run surface (Dashboard, Library) so activation
 * eligibility can never depend on which page a user happened to add their
 * first item from.
 *
 * The previous version tracked "was I just in the onboarding state" per
 * page (a `wasOnboardingRef` local to DashboardView), which meant
 * activating via Library's own empty-state CTA correctly marked
 * hasEverHadLibraryItems but never autoTrackingNudgeEligible — the nudge
 * could never become eligible from that path. The real distinguishing
 * signal isn't "which page's React state said 'onboarding'" — it's
 * simply whether *this session* ever confirmed the library empty (a real,
 * hydrated itemCount === 0, with history not yet settled) before its
 * first item appeared. That's page-agnostic by construction: Dashboard
 * and Library both observe the same underlying items array, just via
 * their own useLibraryItems calls, so whichever one the user happens to
 * be on when the transition happens sees the exact same confirmed-empty
 * -> populated moment.
 *
 * A pre-existing user's very first render under this code never passes
 * through a confirmed-empty moment (their itemCount is already > 0), so
 * they're correctly never marked eligible, on either page — same
 * upgrade-safety guarantee as before, now without the page-anchoring bug.
 */
export function useLibraryActivation({ loading, itemCount }: UseLibraryActivationInput) {
  const onboarding = useOnboarding();
  const hasConfirmedEmptyRef = useRef(false);

  useEffect(() => {
    if (loading || !onboarding.isHydrated) return;
    if (onboarding.hasEverHadLibraryItems) return; // history already settled — nothing left to observe, on any page

    if (itemCount === 0) {
      hasConfirmedEmptyRef.current = true;
      return;
    }

    // itemCount > 0 and history isn't settled yet — this IS the
    // activation moment. Only a genuine "we saw it empty first" this
    // session counts as "just activated"; a pre-existing user's first
    // hydrated read landing directly on itemCount > 0 never sets the ref.
    onboarding.recordLibraryActivated(hasConfirmedEmptyRef.current);
    hasConfirmedEmptyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onboarding's functions are stable-enough setState wrappers; including the whole object would re-run this on every unrelated onboarding-state read.
  }, [loading, itemCount, onboarding.isHydrated, onboarding.hasEverHadLibraryItems]);

  return onboarding;
}
